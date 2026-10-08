'use strict';
/**
 * Billing helpers — the single place that interprets Stripe objects and decides
 * what a payment grants. Used by the webhook, the post-checkout redirect
 * (/api/subscription/activate) and the legacy Tandem activation endpoint, so
 * all three always agree.
 *
 * Stripe API note: our webhook endpoint runs a 2025-03-31.basil-or-later API
 * version, where `subscription.current_period_end` moved onto subscription
 * items and `invoice.subscription` moved to
 * `invoice.parent.subscription_details.subscription`. Helpers read the new
 * locations first and fall back to the old ones.
 */
const { PLANS } = require('../config/pricing');
const billingDb = require('../db/billing');

// Days of Tandem access beyond the paid period, so a slightly-late renewal
// webhook doesn't lock a paying couple out at midnight.
const TANDEM_GRACE_DAYS = 3;

/** Which FocusLedger plan a Stripe price sells: 'autopilot' | 'tandem' | null. */
function planFromPrice(price) {
  if (!price) return null;
  for (const [plan, cfg] of Object.entries(PLANS)) {
    if (price.id && (price.id === cfg.stripe.price_monthly || price.id === cfg.stripe.price_annual)) {
      return plan;
    }
  }
  const productName = typeof price.product === 'object' && price.product ? price.product.name : null;
  const hints = [price.lookup_key, price.nickname, productName].filter(Boolean).join(' ').toLowerCase();
  if (hints.includes('tandem')) return 'tandem';
  if (hints.includes('autopilot')) return 'autopilot';
  return null;
}

/** Normalised view of a Stripe Subscription. */
function subscriptionDetails(sub) {
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const price = item && item.price;
  const interval = price && price.recurring ? price.recurring.interval : null;
  const periodEndSec = (item && item.current_period_end) || (sub && sub.current_period_end) || null;
  const customer = sub && sub.customer;
  return {
    subscriptionId: (sub && sub.id) || null,
    customerId: typeof customer === 'string' ? customer : (customer && customer.id) || null,
    stripeStatus: (sub && sub.status) || null,
    plan: planFromPrice(price),
    billingCycle: interval === 'year' ? 'annual' : (interval === 'month' ? 'monthly' : null),
    periodEnd: periodEndSec ? new Date(periodEndSec * 1000) : null,
    cancelAtPeriodEnd: !!(sub && sub.cancel_at_period_end),
  };
}

/** Subscription id an Invoice belongs to, across Stripe API versions. */
function invoiceSubscriptionId(inv) {
  const fromParent = inv && inv.parent && inv.parent.subscription_details
    ? inv.parent.subscription_details.subscription : null;
  const v = fromParent || (inv && inv.subscription) || null;
  return typeof v === 'string' ? v : (v && v.id) || null;
}

/**
 * Stripe subscription status → app_subscription.status. Only 'active' grants
 * Pro (see middleware/proUtils.js). Note the app spells it 'cancelled'.
 */
function appStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  if (stripeStatus === 'canceled') return 'cancelled';
  return stripeStatus || 'unknown';
}

function tandemExpiry(periodEnd) {
  if (!periodEnd) return null;
  return new Date(periodEnd.getTime() + TANDEM_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

function isPaid(session) {
  return !!session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
}

/**
 * Turn a completed Checkout Session into access. Idempotent: a session that has
 * already been recorded is never applied twice (enforced by a UNIQUE index on
 * app_subscription.checkout_session_id, see migration 1850000000000).
 *
 * @param {object}  opts
 * @param {object}  opts.pool
 * @param {object}  opts.stripe   Stripe client
 * @param {object}  opts.session  Checkout Session (subscription expanded or as an id)
 * @param {number} [opts.userId]  Caller already identified (signed-in request)
 * @returns {Promise<{ status: 'activated'|'already_activated'|'unpaid'|'no_user',
 *                     userId?: number, plan?: string, billingCycle?: string }>}
 */
async function activateCheckoutSession({ pool, stripe, session, userId = null }) {
  if (!isPaid(session)) return { status: 'unpaid' };

  const existing = await billingDb.findBySessionId(pool, session.id);
  if (existing) return { status: 'already_activated', userId: existing.user_id };

  let sub = session.subscription;
  if (typeof sub === 'string') sub = await stripe.subscriptions.retrieve(sub);
  const details = subscriptionDetails(sub);

  const email = (session.customer_details && session.customer_details.email) || session.customer_email || null;
  let resolvedUserId = userId
    || parseInt((session.metadata && session.metadata.user_id) || '', 10)
    || null;
  if (!resolvedUserId && email) resolvedUserId = await billingDb.findUserIdByEmail(pool, email);
  if (!resolvedUserId) {
    console.error('[billing] paid session with no matching user | email:', email, '| session:', session.id);
    return { status: 'no_user' };
  }

  let plan = details.plan
    || (session.metadata && PLANS[session.metadata.plan] ? session.metadata.plan : null);
  if (!plan) {
    console.error('[billing] could not tell which plan session', session.id, 'bought; granting autopilot');
    plan = 'autopilot';
  }
  const billingCycle = details.billingCycle
    || (session.metadata && session.metadata.billing === 'annual' ? 'annual' : 'monthly');

  const result = await billingDb.recordActivation(pool, {
    userId: resolvedUserId,
    sessionId: session.id,
    subscriptionId: details.subscriptionId || session.id,
    customerId: details.customerId || (typeof session.customer === 'string' ? session.customer : null),
    billingCycle,
    periodEnd: details.periodEnd,
    tandemExpiresAt: plan === 'tandem' ? tandemExpiry(details.periodEnd || defaultPeriodEnd(billingCycle)) : null,
  });
  if (result.duplicate) return { status: 'already_activated', userId: resolvedUserId };

  console.log('[billing] activated', plan, billingCycle, 'for user', resolvedUserId, 'via session', session.id);
  return { status: 'activated', userId: resolvedUserId, plan, billingCycle, firstActivation: result.firstActivation };
}

// Only used if Stripe returns no period end (shouldn't happen for subscriptions).
function defaultPeriodEnd(billingCycle) {
  const d = new Date();
  if (billingCycle === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/** Apply a customer.subscription.updated / .deleted event to our records. */
async function syncSubscription(pool, sub, { deleted = false } = {}) {
  const d = subscriptionDetails(sub);
  if (!d.subscriptionId) return null;
  const status = deleted ? 'cancelled' : appStatus(d.stripeStatus);
  const row = await billingDb.syncByStripeSubscription(pool, {
    subscriptionId: d.subscriptionId,
    status,
    periodEnd: d.periodEnd,
    billingCycle: d.billingCycle,
    cancelScheduled: !deleted && d.cancelAtPeriodEnd,
  });
  if (row && d.plan === 'tandem') {
    if (deleted || status === 'cancelled') {
      await billingDb.endTandem(pool, row.user_id);
    } else if (status === 'active' || status === 'past_due') {
      // past_due keeps Tandem through Stripe's retry window; Stripe cancels the
      // subscription (→ deleted event) if retries ultimately fail.
      const exp = tandemExpiry(d.periodEnd);
      if (exp) await billingDb.setTandem(pool, row.user_id, exp);
    }
  }
  return row;
}

/**
 * Immediately cancel every Stripe subscription that could still bill this user
 * (account deletion). Throws if any cancellation fails or Stripe isn't
 * configured while a billable subscription exists — the caller must NOT
 * delete the account in that case, or we'd keep charging a deleted user.
 * @returns {Promise<number>} subscriptions cancelled in Stripe
 */
async function cancelAllStripeSubscriptions(pool, stripe, userId) {
  const rows = await billingDb.listBillableStripeSubscriptions(pool, userId);
  if (!rows.length) return 0;
  if (!stripe) throw new Error('Stripe not configured but user has billable subscriptions');
  let cancelled = 0;
  for (const row of rows) {
    try {
      await stripe.subscriptions.cancel(row.stripe_subscription_id);
      cancelled++;
    } catch (err) {
      // Already gone in Stripe = nothing left to bill; anything else is fatal.
      if (err && err.code === 'resource_missing') continue;
      throw new Error(`cancel ${row.stripe_subscription_id} failed: ${err.message}`);
    }
  }
  return cancelled;
}

module.exports = {
  TANDEM_GRACE_DAYS,
  cancelAllStripeSubscriptions,
  planFromPrice,
  subscriptionDetails,
  invoiceSubscriptionId,
  appStatus,
  tandemExpiry,
  isPaid,
  activateCheckoutSession,
  syncSubscription,
};
