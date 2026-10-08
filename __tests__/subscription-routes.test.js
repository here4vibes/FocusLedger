'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 42, email: 'buyer@example.com' }; next(); },
}));
jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/emailTemplates', () => ({ proWelcomeTemplate: () => ({ subject: 's', html: 'h' }) }));
jest.mock('../db/billing');

const mockStripe = {
  subscriptions: { update: jest.fn(), retrieve: jest.fn(), cancel: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('../lib/stripe-client', () => ({ getStripe: () => mockStripe }));

const billingDb = require('../db/billing');

function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  a.use('/api/subscription', require('../routes/subscription')({ query: jest.fn() }));
  return a;
}

const PERIOD_END_SEC = 1790000000;
function stripeSub(over = {}) {
  return Object.assign({
    id: 'sub_123', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
    items: { data: [{ current_period_end: PERIOD_END_SEC, price: { lookup_key: 'Autopilot_monthly', recurring: { interval: 'month' } } }] },
  }, over);
}
const activeRow = { id: 5, user_id: 42, status: 'active', stripe_subscription_id: 'sub_123', cancelled_at: null };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('POST /cancel', () => {
  test('cancels in STRIPE at period end, then records it — access is kept', async () => {
    billingDb.getLatestSubscription.mockResolvedValue(activeRow);
    mockStripe.subscriptions.update.mockResolvedValue(stripeSub({ cancel_at_period_end: true }));

    const res = await request(app()).post('/api/subscription/cancel');

    expect(res.status).toBe(200);
    expect(res.body.cancel_scheduled).toBe(true);
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true });
    expect(billingDb.setCancelScheduled).toHaveBeenCalledWith(expect.anything(), 5, new Date(PERIOD_END_SEC * 1000));
  });

  test('if Stripe fails, nothing is recorded and the user is told', async () => {
    billingDb.getLatestSubscription.mockResolvedValue(activeRow);
    mockStripe.subscriptions.update.mockRejectedValue(new Error('stripe down'));

    const res = await request(app()).post('/api/subscription/cancel');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(billingDb.setCancelScheduled).not.toHaveBeenCalled();
  });

  test('no paid Stripe subscription → 400, Stripe not called', async () => {
    billingDb.getLatestSubscription.mockResolvedValue({ id: 5, status: 'active', stripe_subscription_id: null });
    const res = await request(app()).post('/api/subscription/cancel');
    expect(res.status).toBe(400);
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('POST /reactivate', () => {
  test('EXPLOIT CLOSED: an ended subscription cannot be re-granted for free', async () => {
    billingDb.getLatestSubscription.mockResolvedValue({ ...activeRow, status: 'cancelled', cancelled_at: new Date() });
    const res = await request(app()).post('/api/subscription/reactivate');
    expect(res.status).toBe(409);
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
    expect(billingDb.clearCancelScheduled).not.toHaveBeenCalled();
  });

  test('a still-paid, scheduled cancellation is undone in Stripe', async () => {
    billingDb.getLatestSubscription.mockResolvedValue({ ...activeRow, cancelled_at: new Date() });
    mockStripe.subscriptions.update.mockResolvedValue(stripeSub());
    const res = await request(app()).post('/api/subscription/reactivate');
    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false });
    expect(billingDb.clearCancelScheduled).toHaveBeenCalledWith(expect.anything(), 5);
  });

  test('if Stripe says the subscription already ended, nothing is granted', async () => {
    billingDb.getLatestSubscription.mockResolvedValue({ ...activeRow, cancelled_at: new Date() });
    mockStripe.subscriptions.update.mockResolvedValue(stripeSub({ status: 'canceled' }));
    const res = await request(app()).post('/api/subscription/reactivate');
    expect(res.status).toBe(409);
    expect(billingDb.clearCancelScheduled).not.toHaveBeenCalled();
  });
});

describe('POST /stripe-webhook', () => {
  function post(event) {
    mockStripe.webhooks.constructEvent.mockReturnValue(event);
    return request(app()).post('/api/subscription/stripe-webhook')
      .set('stripe-signature', 't=1,v1=x').send({ any: 'body' });
  }

  test('bad signature → 400', async () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await request(app()).post('/api/subscription/stripe-webhook').send({});
    expect(res.status).toBe(400);
  });

  test('processing failure → 500 so Stripe retries (used to ack first and drop the event)', async () => {
    billingDb.syncByStripeSubscription.mockRejectedValue(new Error('db down'));
    const res = await post({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: stripeSub() } });
    expect(res.status).toBe(500);
  });

  test('subscription.updated syncs and acks', async () => {
    billingDb.syncByStripeSubscription.mockResolvedValue({ id: 5, user_id: 42 });
    const res = await post({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: stripeSub() } });
    expect(res.status).toBe(200);
    expect(billingDb.syncByStripeSubscription).toHaveBeenCalled();
  });

  test('invoice.payment_failed reads the subscription from the basil+ location', async () => {
    billingDb.markPastDue.mockResolvedValue(1);
    const res = await post({ id: 'evt_3', type: 'invoice.payment_failed',
      data: { object: { parent: { subscription_details: { subscription: 'sub_123' } } } } });
    expect(res.status).toBe(200);
    expect(billingDb.markPastDue).toHaveBeenCalledWith(expect.anything(), 'sub_123');
  });

  test('checkout.session.completed activates via the shared path', async () => {
    billingDb.findBySessionId.mockResolvedValue(null);
    billingDb.findUserIdByEmail.mockResolvedValue(42);
    billingDb.recordActivation.mockResolvedValue({ duplicate: false, firstActivation: false });
    const session = { id: 'cs_9', payment_status: 'paid', customer_details: { email: 'buyer@example.com' }, metadata: {}, subscription: stripeSub() };
    const res = await post({ id: 'evt_4', type: 'checkout.session.completed', data: { object: session } });
    expect(res.status).toBe(200);
    expect(billingDb.recordActivation).toHaveBeenCalled();
  });

  test('unhandled event types are acknowledged', async () => {
    const res = await post({ id: 'evt_5', type: 'invoice.payment_succeeded', data: { object: {} } });
    expect(res.status).toBe(200);
  });
});

describe('legacy POST /webhook', () => {
  test('stays retired (410) — no unauthenticated grant path', async () => {
    const res = await request(app()).post('/api/subscription/webhook')
      .send({ user_email: 'x@y.z', plan: 'pro', status: 'active' });
    expect(res.status).toBe(410);
  });
});

describe('GET /activate → Settings redirect carries the real purchase (Meta Pixel)', () => {
  function qsOf(res) { return new URL('http://x' + res.headers.location).searchParams; }

  test('fast path (webhook won): Tandem annual → value 149.95, deduped by session', async () => {
    billingDb.findBySessionId.mockResolvedValue({ id: 1, user_id: 42 });
    billingDb.getActivationSummary.mockResolvedValue({ billing_cycle: 'annual', tandem: true });
    const res = await request(app()).get('/api/subscription/activate?session_id=cs_live_abc');
    expect(res.status).toBe(302);
    const q = qsOf(res);
    expect(q.get('upgraded')).toBe('true');
    expect(q.get('plan')).toBe('tandem');
    expect(q.get('billing_cycle')).toBe('annual');
    expect(q.get('value')).toBe('149.95');
    expect(q.get('ref')).toBe('cs_live_abc');
  });

  test('fresh activation: Autopilot monthly → value 9.95', async () => {
    billingDb.findBySessionId.mockResolvedValue(null);
    billingDb.findUserIdByEmail.mockResolvedValue(42);
    billingDb.recordActivation.mockResolvedValue({ duplicate: false, firstActivation: false });
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_live_new', payment_status: 'paid', customer_details: { email: 'buyer@example.com' }, metadata: {},
      subscription: stripeSub(),
    });
    const res = await request(app()).get('/api/subscription/activate?session_id=cs_live_new');
    const q = qsOf(res);
    expect(q.get('plan')).toBe('autopilot');
    expect(q.get('billing_cycle')).toBe('monthly');
    expect(q.get('value')).toBe('9.95');
    expect(q.get('ref')).toBe('cs_live_new');
  });
});
