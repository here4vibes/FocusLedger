'use strict';

jest.mock('../db/billing');
const billingDb = require('../db/billing');
const billing = require('../lib/billing');

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_END_SEC = 1790000000; // fixed instant for assertions

// Stripe objects shaped like a 2025-03-31.basil+ API version (period on items).
function stripeSub({ lookup = 'Autopilot_monthly', interval = 'month', status = 'active', cancelAtPeriodEnd = false, id = 'sub_123' } = {}) {
  return {
    id, status, customer: 'cus_1', cancel_at_period_end: cancelAtPeriodEnd,
    items: { data: [{ current_period_end: PERIOD_END_SEC, price: { id: 'price_x', lookup_key: lookup, recurring: { interval } } }] },
  };
}
function paidSession(over = {}) {
  return Object.assign({
    id: 'cs_1', payment_status: 'paid', customer_details: { email: 'buyer@example.com' },
    metadata: {}, subscription: stripeSub(),
  }, over);
}

beforeEach(() => {
  jest.resetAllMocks();
  billingDb.findBySessionId.mockResolvedValue(null);
  billingDb.findUserIdByEmail.mockResolvedValue(42);
  billingDb.recordActivation.mockResolvedValue({ duplicate: false, firstActivation: true });
});

describe('planFromPrice', () => {
  test.each([
    ['Autopilot_monthly', 'autopilot'],
    ['Autopilot_annually', 'autopilot'],
    ['Tandem_monthly', 'tandem'],
    ['Tandem_annually', 'tandem'],
  ])('lookup_key %s → %s', (lookup, plan) => {
    expect(billing.planFromPrice({ lookup_key: lookup })).toBe(plan);
  });
  test('falls back to an expanded product name', () => {
    expect(billing.planFromPrice({ product: { name: 'Tandem' } })).toBe('tandem');
  });
  test('unknown price → null (caller decides)', () => {
    expect(billing.planFromPrice({ lookup_key: 'something_else' })).toBeNull();
    expect(billing.planFromPrice(null)).toBeNull();
  });
});

describe('subscriptionDetails', () => {
  test('reads the billing period from the subscription item (basil+ API)', () => {
    const d = billing.subscriptionDetails(stripeSub({ lookup: 'Tandem_annually', interval: 'year' }));
    expect(d.periodEnd.toISOString()).toBe(new Date(PERIOD_END_SEC * 1000).toISOString());
    expect(d.plan).toBe('tandem');
    expect(d.billingCycle).toBe('annual');
    expect(d.customerId).toBe('cus_1');
  });
  test('falls back to the legacy top-level current_period_end', () => {
    const sub = stripeSub();
    delete sub.items.data[0].current_period_end;
    sub.current_period_end = PERIOD_END_SEC;
    expect(billing.subscriptionDetails(sub).periodEnd).not.toBeNull();
  });
});

describe('invoiceSubscriptionId', () => {
  test('reads parent.subscription_details.subscription (basil+ API)', () => {
    expect(billing.invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_9' } } })).toBe('sub_9');
  });
  test('falls back to legacy invoice.subscription (string or object)', () => {
    expect(billing.invoiceSubscriptionId({ subscription: 'sub_8' })).toBe('sub_8');
    expect(billing.invoiceSubscriptionId({ subscription: { id: 'sub_7' } })).toBe('sub_7');
  });
  test('no subscription → null', () => {
    expect(billing.invoiceSubscriptionId({})).toBeNull();
  });
});

describe('appStatus', () => {
  test('maps Stripe statuses onto app_subscription statuses', () => {
    expect(billing.appStatus('active')).toBe('active');
    expect(billing.appStatus('trialing')).toBe('active');
    expect(billing.appStatus('canceled')).toBe('cancelled');
    expect(billing.appStatus('past_due')).toBe('past_due');
  });
});

describe('activateCheckoutSession', () => {
  const stripe = { subscriptions: { retrieve: jest.fn() } };

  test('unpaid session grants nothing', async () => {
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession({ payment_status: 'unpaid' }) });
    expect(r.status).toBe('unpaid');
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('already-recorded session is never applied twice', async () => {
    billingDb.findBySessionId.mockResolvedValue({ id: 1, user_id: 42 });
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession() });
    expect(r).toEqual({ status: 'already_activated', userId: 42 });
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('Autopilot purchase → Pro only, period end from the subscription item', async () => {
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession() });
    expect(r).toMatchObject({ status: 'activated', userId: 42, plan: 'autopilot', billingCycle: 'monthly' });
    const args = billingDb.recordActivation.mock.calls[0][1];
    expect(args.tandemExpiresAt).toBeNull();
    expect(args.subscriptionId).toBe('sub_123');
    expect(args.periodEnd.getTime()).toBe(PERIOD_END_SEC * 1000);
  });

  test('Tandem purchase → Tandem access through period end + grace (was granted Autopilot)', async () => {
    const session = paidSession({ subscription: stripeSub({ lookup: 'Tandem_annually', interval: 'year' }) });
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session });
    expect(r).toMatchObject({ plan: 'tandem', billingCycle: 'annual' });
    const args = billingDb.recordActivation.mock.calls[0][1];
    expect(args.tandemExpiresAt.getTime()).toBe(PERIOD_END_SEC * 1000 + billing.TANDEM_GRACE_DAYS * DAY);
  });

  test('annual billing comes from the price interval, not session metadata (payment links have none)', async () => {
    const session = paidSession({ metadata: {}, subscription: stripeSub({ lookup: 'Autopilot_annually', interval: 'year' }) });
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session });
    expect(r.billingCycle).toBe('annual');
  });

  test('retrieves the subscription when the session carries only its id (webhook payload)', async () => {
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSub());
    await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession({ subscription: 'sub_123' }) });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_123');
  });

  test('prefers metadata.user_id over the checkout email', async () => {
    await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession({ metadata: { user_id: '7' } }) });
    expect(billingDb.findUserIdByEmail).not.toHaveBeenCalled();
    expect(billingDb.recordActivation.mock.calls[0][1].userId).toBe(7);
  });

  test('no matching user → no_user, nothing recorded', async () => {
    billingDb.findUserIdByEmail.mockResolvedValue(null);
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession() });
    expect(r.status).toBe('no_user');
    expect(billingDb.recordActivation).not.toHaveBeenCalled();
  });

  test('webhook/redirect race: the loser sees already_activated', async () => {
    billingDb.recordActivation.mockResolvedValue({ duplicate: true });
    const r = await billing.activateCheckoutSession({ pool: {}, stripe, session: paidSession() });
    expect(r.status).toBe('already_activated');
  });
});

describe('syncSubscription', () => {
  beforeEach(() => {
    billingDb.syncByStripeSubscription.mockResolvedValue({ id: 1, user_id: 42 });
  });

  test('Tandem renewal extends Tandem access to the new period end + grace', async () => {
    await billing.syncSubscription({}, stripeSub({ lookup: 'Tandem_monthly' }));
    expect(billingDb.setTandem).toHaveBeenCalledWith({}, 42, new Date(PERIOD_END_SEC * 1000 + billing.TANDEM_GRACE_DAYS * DAY));
  });

  test('Tandem subscription deleted → Tandem access ends', async () => {
    await billing.syncSubscription({}, stripeSub({ lookup: 'Tandem_monthly', status: 'canceled' }), { deleted: true });
    expect(billingDb.endTandem).toHaveBeenCalledWith({}, 42);
    expect(billingDb.syncByStripeSubscription.mock.calls[0][1].status).toBe('cancelled');
  });

  test('subscription on the Autopilot price (e.g. downgraded in the portal) ends Tandem, never grants it', async () => {
    await billing.syncSubscription({}, stripeSub({ lookup: 'Autopilot_monthly' }));
    expect(billingDb.setTandem).not.toHaveBeenCalled();
    expect(billingDb.endTandem).toHaveBeenCalledWith({}, 42);
  });

  test('unrecognised price never touches Tandem', async () => {
    await billing.syncSubscription({}, stripeSub({ lookup: 'Mystery_plan' }));
    expect(billingDb.setTandem).not.toHaveBeenCalled();
    expect(billingDb.endTandem).not.toHaveBeenCalled();
  });

  test('cancel scheduled in Stripe (e.g. via dashboard) is mirrored as cancelScheduled', async () => {
    await billing.syncSubscription({}, stripeSub({ cancelAtPeriodEnd: true }));
    expect(billingDb.syncByStripeSubscription.mock.calls[0][1]).toMatchObject({ status: 'active', cancelScheduled: true });
  });

  test('stores the period end (previously always null on basil+ payloads)', async () => {
    await billing.syncSubscription({}, stripeSub());
    expect(billingDb.syncByStripeSubscription.mock.calls[0][1].periodEnd.getTime()).toBe(PERIOD_END_SEC * 1000);
  });
});

describe('cancelAllStripeSubscriptions (account deletion)', () => {
  test('nothing billable → 0, works without Stripe configured', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([]);
    await expect(billing.cancelAllStripeSubscriptions({}, null, 42)).resolves.toBe(0);
  });

  test('billable subscription but Stripe not configured → throws (caller aborts deletion)', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([{ id: 1, stripe_subscription_id: 'sub_1' }]);
    await expect(billing.cancelAllStripeSubscriptions({}, null, 42)).rejects.toThrow(/not configured/);
  });

  test('cancels each subscription in Stripe; already-gone ones are fine', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([
      { id: 1, stripe_subscription_id: 'sub_1' }, { id: 2, stripe_subscription_id: 'sub_2' },
    ]);
    const cancel = jest.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }));
    await expect(billing.cancelAllStripeSubscriptions({}, { subscriptions: { cancel } }, 42)).resolves.toBe(1);
    expect(cancel).toHaveBeenCalledWith('sub_1');
    expect(cancel).toHaveBeenCalledWith('sub_2');
  });

  test('any other Stripe error throws', async () => {
    billingDb.listBillableStripeSubscriptions.mockResolvedValue([{ id: 1, stripe_subscription_id: 'sub_1' }]);
    const cancel = jest.fn().mockRejectedValue(new Error('rate limited'));
    await expect(billing.cancelAllStripeSubscriptions({}, { subscriptions: { cancel } }, 42)).rejects.toThrow(/rate limited/);
  });
});
