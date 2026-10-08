// Subscription management: status, activation, webhook, cancel/reactivate.
// Owns: app_subscription table, Stripe checkout flow, Pro activation.
// Does NOT own: Pro status checks (see middleware/proUtils.js), payment processing (Stripe).
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { proWelcomeTemplate } = require('../lib/emailTemplates');
const { PLANS } = require('../config/pricing');

const FREE_TASK_LIMIT = 10;

// Stripe client is lazy (null without STRIPE_SECRET_KEY). When price IDs are also
// set, POST /checkout creates real Checkout Sessions with email pre-fill; otherwise
// it falls back to buy.stripe.com payment links + ?prefilled_email.
const { getStripe } = require('../lib/stripe-client');
const billing = require('../lib/billing');
const billingDb = require('../db/billing');
const { hasPartnerPaidTandem } = require('../db/partnerships');

// Legacy: kept for backward compat with any code that still imports STRIPE_LINKS directly.
// New code should use PLANS from config/pricing.js.
const STRIPE_LINKS = {
  monthly: PLANS.autopilot.stripe.link_monthly,
  annual:  PLANS.autopilot.stripe.link_annual,
};

module.exports = function(pool) {
  const router = express.Router();

  // POST /checkout — create a Stripe Checkout Session (or return a prefilled payment link).
  // When STRIPE_SECRET_KEY + STRIPE_PRICE_* env vars are set, creates a real Checkout Session
  // so the user's email is pre-filled and user_id is attached as metadata.
  // When price IDs are absent, returns a buy.stripe.com link with ?prefilled_email appended.
  router.post('/checkout', authenticateToken, async (req, res) => {
    try {
      const { plan, billing } = req.body;
      if (!['autopilot', 'tandem'].includes(plan))   return res.status(400).json({ success: false, message: 'Invalid plan' });
      if (!['monthly', 'annual'].includes(billing))  return res.status(400).json({ success: false, message: 'Invalid billing' });

      const planConfig = PLANS[plan];
      const priceId    = planConfig.stripe[`price_${billing}`];
      const baseLink   = planConfig.stripe[`link_${billing}`];
      const userEmail  = req.user.email || '';
      const stripe     = getStripe();

      if (stripe && priceId) {
        const appUrl = (process.env.APP_URL || 'https://focusledger.net').replace(/\/$/, '');
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer_email: userEmail,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${appUrl}/api/subscription/activate?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/pricing`,
          metadata: { user_id: String(req.user.id), plan, billing },
          allow_promotion_codes: true,
          billing_address_collection: 'auto',
        });
        return res.json({ success: true, url: session.url });
      }

      // Fallback: payment link with prefilled email
      const url = userEmail
        ? `${baseLink}?prefilled_email=${encodeURIComponent(userEmail)}`
        : baseLink;
      return res.json({ success: true, url });
    } catch (err) {
      console.error('[subscription/checkout]', err.message);
      res.status(500).json({ success: false, message: 'Could not create checkout session' });
    }
  });

  // GET subscription status + task limits (requires auth)
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const [subResult, userResult, taskCountResult] = await Promise.all([
        pool.query(
          'SELECT * FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
          [userId]
        ),
        pool.query(
          'SELECT admin_pro_override, pro_granted_by, pro_granted_until, autopilot_expires_at, tandem_plan, tandem_expires_at FROM users WHERE id = $1',
          [userId]
        ),
        pool.query(
          'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
          [userId]
        )
      ]);

      const sub = subResult.rows[0] || { plan: 'free', status: 'active' };
      const user = userResult.rows[0] || {};
      const adminProOverride = isAdminProActive(user);
      const promoActive = !!(user.autopilot_expires_at && new Date(user.autopilot_expires_at) > new Date());
      const activeTaskCount = parseInt(taskCountResult.rows[0].count);

      const ownPaidPro = sub.plan === 'pro' && sub.status === 'active';
      // A paid Tandem partner includes Autopilot (and the Tandem features) for this user.
      const partnerPaidTandem = await hasPartnerPaidTandem(pool, userId);
      const isPro = ownPaidPro || adminProOverride || promoActive || partnerPaidTandem;
      const proViaPartner = partnerPaidTandem && !ownPaidPro && !adminProOverride && !promoActive;
      // Tandem: user has an active tandem_plan on their profile (set by partnerships/tandem-activate)
      const isTandem = !!(user.tandem_plan === 'tandem' && user.tandem_expires_at && new Date(user.tandem_expires_at) > new Date()) || partnerPaidTandem;
      // plan_label: human-readable plan name for display in the nav badge
      const planLabel = isTandem ? 'Tandem' : (isPro ? 'Autopilot' : 'Free');

      res.json({
        success: true,
        subscription: {
          plan: sub.plan,
          status: sub.status,
          is_pro: isPro,
          is_tandem: isTandem,
          pro_via_partner: proViaPartner,
          plan_label: planLabel,
          admin_pro_override: adminProOverride,
          pro_granted_by: user.pro_granted_by || null,
          pro_granted_until: user.pro_granted_until || null,
          autopilot_expires_at: user.autopilot_expires_at || null,
          promo_active: promoActive,
          billing_cycle: sub.billing_cycle,
          current_period_end: sub.current_period_end,
          activated_at: sub.activated_at,
          cancelled_at: sub.cancelled_at,
          // Cancelled in Stripe but still paid through current_period_end.
          cancel_scheduled: sub.status === 'active' && !!sub.cancelled_at && !!sub.stripe_subscription_id,
          has_stripe_billing: !!(sub.stripe_subscription_id && String(sub.stripe_subscription_id).startsWith('sub_')),
        },
        // Display prices — single source of truth is config/pricing.js.
        pricing: {
          autopilot: { monthly: PLANS.autopilot.price_monthly, annual: PLANS.autopilot.price_annual },
          tandem:    { monthly: PLANS.tandem.price_monthly,    annual: PLANS.tandem.price_annual },
        },
        limits: {
          active_tasks: activeTaskCount,
          max_tasks: isPro ? null : FREE_TASK_LIMIT,
          tasks_remaining: isPro ? null : Math.max(0, FREE_TASK_LIMIT - activeTaskCount),
          can_create_task: isPro || activeTaskCount < FREE_TASK_LIMIT
        },
        stripe_links: STRIPE_LINKS
      });
    } catch (err) {
      console.error('Error fetching subscription status:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch subscription status' });
    }
  });

  // Pro welcome email — fire-and-forget; never blocks or fails the purchase flow.
  function sendWelcomeEmail({ userId, billingCycle }) {
    billingDb.getUserContact(pool, userId)
      .then(user => {
        if (!user || !user.email) return;
        const { subject, html } = proWelcomeTemplate({ name: user.name, billingCycle });
        return sendEmail(pool, { to: user.email, subject, html, templateType: 'pro_welcome', userId });
      })
      .catch(err => console.error('[billing] welcome email failed:', err.message, '| user:', userId));
  }

  // GET /activate — where Stripe sends the browser after checkout.
  // No auth: a redirect can't carry the JWT. The user is identified from the
  // Stripe-verified session (metadata.user_id, else the checkout email).
  // The webhook does the same activation; whichever runs second is a no-op
  // (UNIQUE checkout_session_id — see lib/billing.activateCheckoutSession).
  router.get('/activate', async (req, res) => {
    const sessionId = req.query.checkout_session_id || req.query.session_id || req.query.session;
    try {
      if (!sessionId) {
        return res.redirect('/app/settings?error=missing_session');
      }

      // Fast path: already recorded (usually the webhook got there first).
      if (await billingDb.findBySessionId(pool, sessionId)) {
        return res.redirect('/app/settings?upgraded=true');
      }

      const stripe = getStripe();
      if (!stripe) {
        console.error('[subscription/activate] STRIPE_SECRET_KEY not set — cannot verify payment');
        return res.redirect('/app/settings?error=activation_failed');
      }
      // Verify with Stripe — never trust the session id alone.
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
      const result = await billing.activateCheckoutSession({ pool, stripe, session });

      if (result.status === 'unpaid')  return res.redirect('/app/settings?error=payment_not_verified');
      if (result.status === 'no_user') return res.redirect('/app/settings?error=user_not_found');
      if (result.status === 'activated' && result.firstActivation) sendWelcomeEmail(result);

      const cycle = result.billingCycle ? '&billing_cycle=' + encodeURIComponent(result.billingCycle) : '';
      res.redirect('/app/settings?upgraded=true' + cycle);
    } catch (err) {
      console.error('[subscription/activate] failed:', err.message, '| session:', sessionId);
      res.redirect('/app/settings?error=activation_failed');
    }
  });

  // POST /stripe-webhook — REAL Stripe events, signature-verified.
  // Stripe dashboard → Developers → Webhooks:
  //   URL:    https://focusledger.net/api/subscription/stripe-webhook
  //   Events: checkout.session.completed, customer.subscription.updated,
  //           customer.subscription.deleted, invoice.payment_failed
  // Signing secret → Render env STRIPE_WEBHOOK_SECRET.
  router.post('/stripe-webhook', async (req, res) => {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) {
      console.error('[stripe-webhook] not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing)');
      return res.status(503).json({ success: false, message: 'Webhook not configured' });
    }

    let event;
    try {
      // req.rawBody is captured by the global express.json verify hook
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], secret);
    } catch (err) {
      console.error('[stripe-webhook] signature verification failed:', err.message);
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // Process BEFORE acking. A non-2xx makes Stripe retry, which is safe because
    // every handler is idempotent. (This used to ack first, so a DB hiccup
    // silently dropped the event — a paying customer could end up without access.)
    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const result = await billing.activateCheckoutSession({ pool, stripe, session: event.data.object });
          if (result.status === 'activated' && result.firstActivation) sendWelcomeEmail(result);
          break;
        }
        case 'customer.subscription.updated':
          await billing.syncSubscription(pool, event.data.object);
          break;
        case 'customer.subscription.deleted':
          await billing.syncSubscription(pool, event.data.object, { deleted: true });
          break;
        case 'invoice.payment_failed': {
          // Also reflected by the customer.subscription.updated (status=past_due)
          // Stripe sends alongside; kept as a belt-and-braces signal.
          const subId = billing.invoiceSubscriptionId(event.data.object);
          if (subId) await billingDb.markPastDue(pool, subId);
          break;
        }
        default:
          break; // subscribed to more event types than we act on — ignore the rest
      }
      res.json({ received: true });
    } catch (err) {
      console.error('[stripe-webhook] processing error:', err.message, '| event:', event.type, event.id);
      res.status(500).json({ success: false, message: 'Processing failed — Stripe will retry' });
    }
  });

  // POST /webhook — DISABLED legacy sync endpoint. Was previously
  // unauthenticated and body-trusting (anyone could POST {user_email,
  // plan:'pro'} to grant themselves a subscription). Superseded by the
  // signature-verified /stripe-webhook above. Always 410.
  router.post('/webhook', (req, res) => {
    res.status(410).json({ success: false, message: 'Endpoint retired — use Stripe webhook' });
  });

  // POST /cancel — cancel at the end of the paid period.
  // Tells STRIPE first (cancel_at_period_end); only then records it. Access
  // continues until Stripe actually ends the subscription, which arrives as
  // customer.subscription.deleted. (This used to only flip our DB row to
  // 'cancelled' — Stripe kept billing the card and Pro vanished immediately.)
  router.post('/cancel', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
      const sub = await billingDb.getLatestSubscription(pool, userId);
      const subId = sub && sub.stripe_subscription_id;
      if (!sub || sub.status !== 'active' || !subId || !String(subId).startsWith('sub_')) {
        return res.status(400).json({ success: false, message: 'There’s no active paid subscription to cancel.' });
      }
      const stripe = getStripe();
      if (!stripe) {
        console.error('[subscription/cancel] STRIPE_SECRET_KEY not set | user:', userId);
        return res.status(503).json({ success: false, message: 'Billing is temporarily unavailable. Please try again shortly.' });
      }

      const updated = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
      const { periodEnd } = billing.subscriptionDetails(updated);
      await billingDb.setCancelScheduled(pool, sub.id, periodEnd);

      const until = periodEnd ? periodEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the end of your billing period';
      console.log('[subscription/cancel] scheduled cancellation | user:', userId, '| sub:', subId, '| ends:', periodEnd && periodEnd.toISOString());
      res.json({ success: true, cancel_scheduled: true, current_period_end: periodEnd, message: `Cancelled. You won’t be charged again, and you keep everything until ${until}.` });
    } catch (err) {
      console.error('[subscription/cancel] failed:', err.message, '| user:', userId);
      res.status(500).json({ success: false, message: 'Couldn’t cancel just now — nothing was changed. Please try again.' });
    }
  });

  // POST /reactivate — undo a scheduled cancellation, in Stripe.
  // Only valid while the subscription is still paid up (status active +
  // cancellation pending). It used to set status='active' unconditionally,
  // which let anyone whose subscription had ended re-grant themselves Pro free.
  router.post('/reactivate', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    try {
      const sub = await billingDb.getLatestSubscription(pool, userId);
      const subId = sub && sub.stripe_subscription_id;
      const pending = sub && sub.status === 'active' && sub.cancelled_at && subId && String(subId).startsWith('sub_');
      if (!pending) {
        return res.status(409).json({ success: false, message: 'There’s no pending cancellation to undo. If your plan has ended, you can subscribe again from Pricing.' });
      }
      const stripe = getStripe();
      if (!stripe) {
        console.error('[subscription/reactivate] STRIPE_SECRET_KEY not set | user:', userId);
        return res.status(503).json({ success: false, message: 'Billing is temporarily unavailable. Please try again shortly.' });
      }

      const updated = await stripe.subscriptions.update(subId, { cancel_at_period_end: false });
      if (billing.appStatus(updated.status) !== 'active') {
        console.warn('[subscription/reactivate] stripe sub not active after undo | user:', userId, '| status:', updated.status);
        return res.status(409).json({ success: false, message: 'That subscription has already ended. You can subscribe again from Pricing.' });
      }
      await billingDb.clearCancelScheduled(pool, sub.id);
      console.log('[subscription/reactivate] cancellation undone | user:', userId, '| sub:', subId);
      res.json({ success: true, message: 'You’re all set — your plan will keep renewing.' });
    } catch (err) {
      console.error('[subscription/reactivate] failed:', err.message, '| user:', userId);
      res.status(500).json({ success: false, message: 'Couldn’t reactivate just now — nothing was changed. Please try again.' });
    }
  });

  return router;
};

// Check if admin-granted Pro is active (respects expiry if set).
// WHY null check: older admin grants don't have pro_granted_until set — treat as permanent.
function isAdminProActive(user) {
  if (!user.admin_pro_override) return false;
  if (!user.pro_granted_until) return true; // No expiry = permanent override
  return new Date(user.pro_granted_until) > new Date();
}
