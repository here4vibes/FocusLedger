'use strict';
// Security-relevant billing paths: the Tandem unlock endpoint and account
// deletion's stop-billing-first guarantee.

const express = require('express');
const request = require('supertest');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, _res, next) => { req.user = { id: 42, email: 'buyer@example.com' }; next(); },
}));
jest.mock('../lib/emailService', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../lib/emailTemplates', () => ({ accountDeletionTemplate: () => ({ subject: 's', html: 'h' }) }));
jest.mock('../db/billing');
jest.mock('../db/partnerships', () => ({
  checkTandemAccess: jest.fn().mockResolvedValue({ hasTandem: true, reason: 'paid' }),
}));
jest.mock('../db/account-deletion', () => ({
  createDeletionToken: jest.fn(), findValidToken: jest.fn(), markTokenUsed: jest.fn(),
  deleteUserCascade: jest.fn(), getUserById: jest.fn(), getUserAdminInfo: jest.fn(),
  cancelActiveSubscription: jest.fn(),
}));

const mockStripe = {
  subscriptions: { retrieve: jest.fn(), cancel: jest.fn() },
  checkout: { sessions: { retrieve: jest.fn() } },
};
jest.mock('../lib/stripe-client', () => ({ getStripe: () => mockStripe }));

const billingDb = require('../db/billing');
const deletionDb = require('../db/account-deletion');

const tandemSub = {
  id: 'sub_t', status: 'active', customer: 'cus_1',
  items: { data: [{ current_period_end: 1790000000, price: { lookup_key: 'Tandem_monthly', recurring: { interval: 'month' } } }] },
};
const autopilotSub = {
  ...tandemSub, id: 'sub_a',
  items: { data: [{ current_period_end: 1790000000, price: { lookup_key: 'Autopilot_monthly', recurring: { interval: 'month' } } }] },
};
function session(over = {}) {
  return Object.assign({
    id: 'cs_t', payment_status: 'paid', customer_details: { email: 'buyer@example.com' },
    metadata: {}, subscription: tandemSub,
  }, over);
}

function partnershipsApp() {
  const a = express(); a.use(express.json());
  a.use('/api/partnerships', require('../routes/partnerships')({ query: jest.fn() }));
  return a;
}
function deletionApp() {
  const a = express(); a.use(express.json());
  a.use('/api/account', require('../routes/account-deletion')({ query: jest.fn() }));
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  billingDb.findBySessionId.mockResolvedValue(null);
  billingDb.recordActivation.mockResolvedValue({ duplicate: false, firstActivation: true });
});

describe('POST /api/partnerships/tandem-activate', () => {
  const post = () => request(partnershipsApp()).post('/api/partnerships/tandem-activate').send({ session_id: 'cs_t' });

  test('rejects a session that belongs to another user (metadata)', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session({ metadata: { user_id: '99' } }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('rejects a session bought with a different email', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session({ customer_details: { email: 'someone@else.com' } }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('rejects an Autopilot purchase (no Tandem for Autopilot money)', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session({ subscription: autopilotSub }));
    const res = await post();
    expect(res.status).toBe(400);
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('rejects a session already used by another account (single-use)', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session());
    billingDb.findBySessionId.mockResolvedValue({ id: 1, user_id: 77 });
    const res = await post();
    expect(res.status).toBe(403);
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('unpaid session → 402', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session({ payment_status: 'unpaid' }));
    const res = await post();
    expect(res.status).toBe(402);
  });

  test('owner of a paid Tandem session gets Tandem', async () => {
    mockStripe.checkout.sessions.retrieve.mockResolvedValue(session());
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.hasTandem).toBe(true);
    expect(billingDb.recordActivation.mock.calls[0][1].tandemExpiresAt).toBeInstanceOf(Date);
  });
});

describe('POST /api/account/confirm (deletion)', () => {
  beforeEach(() => {
    deletionDb.findValidToken.mockResolvedValue({ id: 3, user_id: 42 });
    deletionDb.getUserById.mockResolvedValue({ email: 'buyer@example.com' });
  });
  const post = () => request(deletionApp()).post('/api/account/confirm').send({ token: 'tok' });

  test('cancels Stripe billing before deleting the account', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([{ id: 1, stripe_subscription_id: 'sub_1' }]);
    mockStripe.subscriptions.cancel.mockResolvedValue({});
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1');
    const cancelOrder = mockStripe.subscriptions.cancel.mock.invocationCallOrder[0];
    const deleteOrder = deletionDb.deleteUserCascade.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(deleteOrder);
  });

  test('if Stripe cancellation fails, the account is NOT deleted', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([{ id: 1, stripe_subscription_id: 'sub_1' }]);
    mockStripe.subscriptions.cancel.mockRejectedValue(new Error('stripe down'));
    const res = await post();
    expect(res.status).toBe(502);
    expect(deletionDb.deleteUserCascade).not.toHaveBeenCalled();
  });

  test('users with no paid subscription delete normally', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(deletionDb.deleteUserCascade).toHaveBeenCalled();
  });
});
