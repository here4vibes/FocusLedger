// Subscription management: status, activation, webhook, cancel/reactivate.
// Owns: app_subscription table, Stripe link references, Pro activation flow.
// Does NOT own: Pro status checks (see middleware/proUtils.js), payment processing (Polsia Stripe).
const express = require('express');
const { authenticateToken, verifyToken } = require('../middleware/auth');
const { sendEmail } = require('../lib/emailService');
const { proWelcomeTemplate } = require('../lib/emailTemplates');

const FREE_TASK_LIMIT = 10;

// Stripe recurring subscription links — success_url includes {CHECKOUT_SESSION_ID} for activation
// WHY recurring: one-time payment links required users to re-checkout every month.
// These are proper subscriptions — Stripe handles billing automatically.
// WHY new links (2026-05-16): old links created Stripe products named "Pro"; these create
// products named "Autopilot" so Stripe receipts, invoices, and customer portal match the rebrand.
const STRIPE_LINKS = {
  monthly: 'https://buy.stripe.com/8x200i6m784y4bS0KZcs800',
  annual: 'https://buy.stripe.com/4gM14m7qb0C60ZGbpDcs801'
};

module.exports = function(pool) {
  const router = express.Router();

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
  // customer_email returned from Polsia's payment verification instead.
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

      // Verify payment with Polsia — never trust the session ID alone
      const verifyResponse = await fetch(
        `${process.env.POLSIA_API_URL}/api/company-payments/verify?session_id=${encodeURIComponent(sessionId)}`,
        { headers: { Authorization: `Bearer ${process.env.POLSIA_API_KEY}` } }
      );
      const { verified, payment } = await verifyResponse.json();

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

      if (!userId && payment?.customer_email) {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
          [payment.customer_email]
        );
        if (userResult.rows.length > 0) userId = userResult.rows[0].id;
      }

      if (!userId) {
        return res.redirect('/app/settings?error=user_not_found');
      }

      const billingCycle = (payment?.product_name || '').toLowerCase().includes('annual') ? 'annual' : 'monthly';

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

  // POST webhook — for Polsia to sync subscription status (no auth - called by Polsia)
  router.post('/webhook', async (req, res) => {
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
