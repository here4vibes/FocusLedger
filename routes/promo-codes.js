// routes/promo-codes.js
// Owns: admin promo code CRUD (/api/admin/promo-codes) + user redemption (/api/promo/redeem).
// Does NOT own: subscription state (proUtils.js), Stripe billing (subscription.js).
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  createPromoCode,
  listPromoCodes,
  updatePromoCode,
  findPromoCode,
  hasUserRedeemed,
  redeemPromoCode,
  getAutopilotExpiry
} = require('../db/promo-codes');
const { queryWithRetry } = require('../lib/queryWithRetry');

function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

async function requireAdmin(pool, userId) {
  const result = await queryWithRetry(pool, 'SELECT is_admin, email FROM users WHERE id = $1', [userId]);
  const user = result.rows[0] || {};
  if (!isAdminUser(user)) {
    const err = new Error('Admin access required');
    err.status = 403;
    throw err;
  }
}

module.exports = function(pool) {
  const adminRouter = express.Router();
  const promoRouter = express.Router();

  // ── Admin routes: /api/admin/promo-codes ─────────────────────────────────

  // POST /api/admin/promo-codes — create a new code
  adminRouter.post('/', authenticateToken, async (req, res) => {
    try {
      await requireAdmin(pool, req.user.id);

      const { code, type, value, max_redemptions, expires_at } = req.body;

      if (!code || !value) {
        return res.status(400).json({ success: false, message: 'code and value are required' });
      }
      if (typeof value !== 'number' || value < 1) {
        return res.status(400).json({ success: false, message: 'value must be a positive integer (days)' });
      }
      if (type && !['trial_extension', 'free_period'].includes(type)) {
        return res.status(400).json({ success: false, message: 'type must be trial_extension or free_period' });
      }

      const created = await createPromoCode(pool, {
        code,
        type: type || 'free_period',
        value,
        max_redemptions: max_redemptions || null,
        expires_at: expires_at || null,
        created_by: req.user.id
      });

      res.json({ success: true, promo_code: created });
    } catch (err) {
      if (err.status === 403) return res.status(403).json({ success: false, message: err.message });
      // WHY: unique violation means duplicate code
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'A promo code with that name already exists' });
      }
      console.error('[promo-codes] create error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to create promo code' });
    }
  });

  // GET /api/admin/promo-codes — list all codes
  adminRouter.get('/', authenticateToken, async (req, res) => {
    try {
      await requireAdmin(pool, req.user.id);
      const codes = await listPromoCodes(pool);
      res.json({ success: true, promo_codes: codes });
    } catch (err) {
      if (err.status === 403) return res.status(403).json({ success: false, message: err.message });
      console.error('[promo-codes] list error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch promo codes' });
    }
  });

  // PATCH /api/admin/promo-codes/:id — toggle is_active, update max_redemptions/expires_at
  adminRouter.patch('/:id', authenticateToken, async (req, res) => {
    try {
      await requireAdmin(pool, req.user.id);

      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

      const { is_active, max_redemptions, expires_at } = req.body;
      const updated = await updatePromoCode(pool, id, { is_active, max_redemptions, expires_at });

      if (!updated) {
        return res.status(404).json({ success: false, message: 'Promo code not found' });
      }

      res.json({ success: true, promo_code: updated });
    } catch (err) {
      if (err.status === 403) return res.status(403).json({ success: false, message: err.message });
      console.error('[promo-codes] update error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update promo code' });
    }
  });

  // ── User-facing route: /api/promo/redeem ────────────────────────────────

  // POST /api/promo/redeem — redeem a promo code for the authenticated user
  promoRouter.post('/redeem', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { code } = req.body;

      if (!code || typeof code !== 'string') {
        return res.status(400).json({ success: false, message: 'code is required' });
      }

      const promo = await findPromoCode(pool, code.trim());

      if (!promo) {
        return res.status(404).json({ success: false, message: 'Invalid promo code' });
      }
      if (!promo.is_active) {
        return res.status(400).json({ success: false, message: 'This promo code is no longer active' });
      }
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return res.status(400).json({ success: false, message: 'This promo code has expired' });
      }
      if (promo.max_redemptions !== null && promo.redemption_count >= promo.max_redemptions) {
        return res.status(400).json({ success: false, message: 'This promo code has reached its maximum redemptions' });
      }

      const alreadyRedeemed = await hasUserRedeemed(pool, promo.id, userId);
      if (alreadyRedeemed) {
        return res.status(409).json({ success: false, message: 'You have already redeemed this promo code' });
      }

      const result = await redeemPromoCode(pool, promo.id, userId, promo.value);

      res.json({
        success: true,
        days_granted: result.days_granted,
        autopilot_expires_at: result.autopilot_expires_at
      });
    } catch (err) {
      // WHY: unique violation = race condition on double-submit
      if (err.code === '23505') {
        return res.status(409).json({ success: false, message: 'You have already redeemed this promo code' });
      }
      console.error('[promo/redeem] error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to redeem promo code' });
    }
  });

  // GET /api/promo/status — return user's current promo autopilot expiry
  promoRouter.get('/status', authenticateToken, async (req, res) => {
    try {
      const expiry = await getAutopilotExpiry(pool, req.user.id);
      const isPromoActive = expiry && new Date(expiry) > new Date();
      res.json({ success: true, autopilot_expires_at: expiry, is_promo_active: isPromoActive });
    } catch (err) {
      console.error('[promo/status] error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch promo status' });
    }
  });

  return { adminRouter, promoRouter };
};
