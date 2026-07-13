// Subscription management: status, activation, webhook, cancel/reactivate.
// Owns: app_subscription table, Stripe checkout flow, Pro activation.
// Does NOT own: Pro status checks (see middleware/proUtils.js), payment processing (Stripe).
const express = require('express');
const { authenticateToken, verifyToken } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { proWelcomeTemplate } = require('../lib/emailTemplates');
const { PLANS } = require('../config/pricing');

const FREE_TASK_LIMIT = 10;

// WHY lazy init: STRIPE_SECRET_KEY may not be present in all environments (CI, dev without .env).
// When price IDs are also set, POST /checkout creates real Checkout Sessions with email pre-fill.
// When price IDs are absent, falls back to buy.stripe.com payment links + ?prefilled_email param.
let stripeClient = null;
function getStripe() {
  if (!stripeClient && process.env.STRIPE_SECRET_KEY) {
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

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

      const isPro = (sub.plan === 'pro' && sub.status === 'active') || adminProOverride || promoActive;
      // Tandem: user has an active tandem_plan on their profile (set by partnerships/tandem-activate)
      const isTandem = !!(user.tandem_plan === 'tandem' && user.tandem_expires_at && new Date(user.tandem_expires_at) > new Date());
      // plan_label: human-readable plan name for display in the nav badge
      const planLabel = isTandem ? 'Tandem' : (isPro ? 'Autopilot' : 'Free');

      res.json({
        success: true,
        subscription: {
          plan: sub.plan,
          status: sub.status,
          is_pro: isPro,
          is_tandem: isTandem,
          plan_label: planLabel,
          admin_pro_override: adminProOverride,
          pro_granted_by: user.pro_granted_by || null,
          pro_granted_until: user.pro_granted_until || null,
          autopilot_expires_at: user.autopilot_expires_at || null,
          promo_active: promoActive,
          billing_cycle: sub.billing_cycle,
          current_period_end: sub.current_period_end,
          activated_at: sub.activated_at,
          cancelled_at: sub.cancelled_at
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

  // GET activate — redirect from Stripe checkout success.
  // WHY no authenticateToken: Stripe redirects the browser here via GET — JWT is in
  // localStorage and cannot be attached to a redirect. We identify the user by the
  // verified Stripe checkout session instead.
  // Idempotency: checkout_session_id has a UNIQUE index; duplicate activations are no-ops.
  router.get('/activate', async (req, res) => {
    try {
      const sessionId = req.query.checkout_session_id || req.query.session_id || req.query.session;

      if (!sessionId) {
        return res.redirect('/app/settings?error=missing_session');
      }

      // Idempotency check: if this session was already activated, skip to success
      const existing = await pool.query(
        'SELECT id FROM app_subscription WHERE checkout_session_id = $1',
        [sessionId]
      );
      if (existing.rows.length > 0) {
        return res.redirect('/app/settings?upgraded=true');
      }

      // Verify payment directly with Stripe — the source of truth. Never
      // trust the session ID alone.
      let verified = false;
      let payment = null;
      const stripe = getStripe();
      if (!stripe) {
        console.error('[subscription/activate] STRIPE_SECRET_KEY not set — cannot verify payment');
        return res.redirect('/app/settings?error=activation_failed');
      }
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
      verified = !!session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
      if (verified) {
        const interval = session.subscription?.items?.data?.[0]?.price?.recurring?.interval || null;
        payment = {
          customer_email: session.customer_details?.email || session.customer_email || null,
          subscription_id: typeof session.subscription === 'object' && session.subscription
            ? session.subscription.id
            : session.subscription,
          metadata_user_id: session.metadata?.user_id || null,
          interval,
          product_name: session.metadata?.billing || '',
        };
      }

      if (!verified) {
        return res.redirect('/app/settings?error=payment_not_verified');
      }

      // Identify user: try Bearer token first, then fall back to payment email
      let userId = null;

      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1];
      if (token) {
        try {
          const decoded = verifyToken(token);
          userId = decoded?.id;
        } catch {
          // Token invalid/expired — fall through to email lookup
        }
      }

      // Checkout Sessions created by POST /checkout carry the user id in metadata
      if (!userId && payment?.metadata_user_id) {
        userId = parseInt(payment.metadata_user_id, 10) || null;
      }

      if (!userId && payment?.customer_email) {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
          [payment.customer_email]
        );
        if (userResult.rows.length > 0) userId = userResult.rows[0].id;
      }

      if (!userId) {
        console.error('[subscription/activate] paid session with no matching user | email:', payment?.customer_email, '| session:', sessionId);
        return res.redirect('/app/settings?error=user_not_found');
      }

      const billingCycle = payment?.interval === 'year'
        ? 'annual'
        : (payment?.interval === 'month'
          ? 'monthly'
          : ((payment?.product_name || '').toLowerCase().includes('annual') ? 'annual' : 'monthly'));

      // WHY subscription_id fallback: subscription-mode checkout sessions return the real
      // Stripe subscription ID via the verify response. One-time sessions don't have one.
      // We prefer the real sub ID for webhook correlation, but fall back to session ID.
      const stripeSubId = payment?.subscription_id || payment?.stripe_subscription_id || sessionId;

      // Check if this is a first-time activation (activated_at was null before now)
      // — used to gate the welcome email (skip renewals)
      const prevSubResult = await pool.query(
        'SELECT activated_at FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
        [userId]
      );
      const isFirstActivation = !prevSubResult.rows[0]?.activated_at;

      const updateResult = await pool.query(`
        UPDATE app_subscription
        SET plan = 'pro',
            status = 'active',
            billing_cycle = $1,
            stripe_subscription_id = $2,
            checkout_session_id = $3,
            activated_at = NOW(),
            cancelled_at = NULL,
            updated_at = NOW()
        WHERE user_id = $4 AND id = (SELECT id FROM app_subscription WHERE user_id = $4 ORDER BY id DESC LIMIT 1)
      `, [billingCycle, stripeSubId, sessionId, userId]);

      // If no row was updated (user had no subscription row), insert one
      if (updateResult.rowCount === 0) {
        await pool.query(`
          INSERT INTO app_subscription (plan, status, billing_cycle, stripe_subscription_id, checkout_session_id, user_id, activated_at)
          VALUES ('pro', 'active', $1, $2, $3, $4, NOW())
        `, [billingCycle, stripeSubId, sessionId, userId]);
      }

      // Set pro_granted_by = 'stripe' on the user record
      await pool.query(
        `UPDATE users SET pro_granted_by = 'stripe' WHERE id = $1`,
        [userId]
      );

      // Send Pro welcome email on first-time activation only — fire-and-forget, never blocks redirect
      if (isFirstActivation) {
        pool.query('SELECT email, name FROM users WHERE id = $1', [userId])
          .then(({ rows }) => {
            const user = rows[0];
            if (!user?.email) return;
            const { subject, html } = proWelcomeTemplate({ name: user.name, billingCycle });
            return sendEmail(pool, { to: user.email, subject, html, templateType: 'pro_welcome', userId });
          })
          .catch(err => console.error('[subscription/activate] Pro welcome email failed:', err.message));
      }

      res.redirect('/app/settings?upgraded=true&billing_cycle=' + encodeURIComponent(billingCycle));
    } catch (err) {
      console.error('Error activating subscription:', err);
      res.redirect('/app/settings?error=activation_failed');
    }
  });

  // POST /stripe-webhook — REAL Stripe events, signature-verified.
  // Configure in Stripe dashboard → Developers → Webhooks:
  //   URL:    https://focusledger.net/api/subscription/stripe-webhook
  //   Events: checkout.session.completed, customer.subscription.updated,
  //           customer.subscription.deleted, invoice.payment_failed
  // Copy the signing secret into Render env as STRIPE_WEBHOOK_SECRET.
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

    res.json({ received: true }); // ack fast — Stripe retries on non-2xx

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return;

        // Idempotent with GET /activate via unique checkout_session_id
        const existing = await pool.query(
          'SELECT id FROM app_subscription WHERE checkout_session_id = $1', [session.id]
        );
        if (existing.rows.length) return;

        let userId = parseInt(session.metadata?.user_id || '', 10) || null;
        const email = session.customer_details?.email || session.customer_email || null;
        if (!userId && email) {
          const u = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
          userId = u.rows[0]?.id || null;
        }
        if (!userId) {
          console.error('[stripe-webhook] PAID session with no matching user | email:', email, '| session:', session.id);
          return;
        }

        const subId = typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription?.id || session.id);
        const billing = session.metadata?.billing === 'annual' ? 'annual' : 'monthly';

        const upd = await pool.query(`
          UPDATE app_subscription
          SET plan = 'pro', status = 'active', billing_cycle = $1,
              stripe_subscription_id = $2, checkout_session_id = $3,
              activated_at = COALESCE(activated_at, NOW()), cancelled_at = NULL, updated_at = NOW()
          WHERE user_id = $4 AND id = (SELECT id FROM app_subscription WHERE user_id = $4 ORDER BY id DESC LIMIT 1)
        `, [billing, subId, session.id, userId]);
        if (upd.rowCount === 0) {
          await pool.query(`
            INSERT INTO app_subscription (plan, status, billing_cycle, stripe_subscription_id, checkout_session_id, user_id, activated_at)
            VALUES ('pro', 'active', $1, $2, $3, $4, NOW())
          `, [billing, subId, session.id, userId]);
        }
        await pool.query(`UPDATE users SET pro_granted_by = 'stripe' WHERE id = $1`, [userId]);
        console.log('[stripe-webhook] activated user', userId, 'via session', session.id);

      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        await pool.query(
          `UPDATE app_subscription SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
           WHERE stripe_subscription_id = $1`, [sub.id]
        );
        console.log('[stripe-webhook] cancelled subscription', sub.id);

      } else if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const status = sub.status === 'past_due' ? 'past_due' : (sub.status === 'active' ? 'active' : sub.status);
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
        const interval = sub.items?.data?.[0]?.price?.recurring?.interval || null;
        await pool.query(`
          UPDATE app_subscription
          SET status = $1,
              current_period_end = COALESCE($2, current_period_end),
              billing_cycle = COALESCE($3, billing_cycle),
              updated_at = NOW()
          WHERE stripe_subscription_id = $4
        `, [status, periodEnd, interval === 'year' ? 'annual' : (interval === 'month' ? 'monthly' : null), sub.id]);
        console.log('[stripe-webhook] synced subscription', sub.id, '→', status);

      } else if (event.type === 'invoice.payment_failed') {
        const inv = event.data.object;
        const subId = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id;
        if (subId) {
          await pool.query(
            `UPDATE app_subscription SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
            [subId]
          );
          console.log('[stripe-webhook] payment failed for', subId);
        }
      }
    } catch (err) {
      console.error('[stripe-webhook] processing error:', err.message, '| event:', event.type);
    }
  });

  // POST /webhook — DISABLED legacy sync endpoint. Was previously
  // unauthenticated and body-trusting (anyone could POST {user_email,
  // plan:'pro'} to grant themselves a subscription). Superseded by the
  // signature-verified /stripe-webhook above. Always 410.
  router.post('/webhook', async (req, res) => {
    return res.status(410).json({ success: false, message: 'Endpoint retired — use Stripe webhook' });
    /* eslint-disable no-unreachable */
    const expected = null;
    if (!expected) {
      return res.status(410).json({ success: false, message: 'Legacy webhook disabled' });
    }
    const provided = (req.headers['authorization'] || '').split(' ')[1];
    if (provided !== expected) {
      console.warn('[subscription/webhook] rejected unauthenticated legacy webhook call');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
      const { plan, status, stripe_subscription_id, billing_cycle, current_period_end, user_email } = req.body;

      // Try to find user by email or stripe_subscription_id
      let userId = null;
      if (user_email) {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
          [user_email]
        );
        if (userResult.rows.length > 0) userId = userResult.rows[0].id;
      }

      if (userId) {
        await pool.query(`
          UPDATE app_subscription
          SET plan = COALESCE($1, plan),
              status = COALESCE($2, status),
              stripe_subscription_id = COALESCE($3, stripe_subscription_id),
              billing_cycle = COALESCE($4, billing_cycle),
              current_period_end = $5,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END,
              updated_at = NOW()
          WHERE user_id = $6 AND id = (SELECT id FROM app_subscription WHERE user_id = $6 ORDER BY id DESC LIMIT 1)
        `, [plan, status, stripe_subscription_id, billing_cycle, current_period_end || null, userId]);
      } else if (stripe_subscription_id) {
        // Fallback: update by stripe_subscription_id
        await pool.query(`
          UPDATE app_subscription
          SET plan = COALESCE($1, plan),
              status = COALESCE($2, status),
              billing_cycle = COALESCE($3, billing_cycle),
              current_period_end = $4,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END,
              updated_at = NOW()
          WHERE stripe_subscription_id = $5
        `, [plan, status, billing_cycle, current_period_end || null, stripe_subscription_id]);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Error processing webhook:', err);
      res.status(500).json({ success: false, message: 'Failed to process webhook' });
    }
  });

  // POST cancel subscription (requires auth)
  router.post('/cancel', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      await pool.query(`
        UPDATE app_subscription
        SET status = 'cancelled',
            cancelled_at = NOW(),
            updated_at = NOW()
        WHERE user_id = $1 AND id = (SELECT id FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1)
      `, [userId]);

      res.json({ success: true, message: 'Subscription cancelled. You can still use Autopilot features until the current period ends.' });
    } catch (err) {
      console.error('Error cancelling subscription:', err);
      res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
    }
  });

  // POST reactivate subscription (requires auth)
  router.post('/reactivate', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      await pool.query(`
        UPDATE app_subscription
        SET status = 'active',
            cancelled_at = NULL,
            updated_at = NOW()
        WHERE user_id = $1 AND plan = 'pro'
          AND id = (SELECT id FROM app_subscription WHERE user_id = $1 ORDER BY id DESC LIMIT 1)
      `, [userId]);

      res.json({ success: true, message: 'Subscription reactivated!' });
    } catch (err) {
      console.error('Error reactivating subscription:', err);
      res.status(500).json({ success: false, message: 'Failed to reactivate subscription' });
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
