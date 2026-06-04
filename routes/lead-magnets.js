// routes/lead-magnets.js
// Owns: public lead capture via /api/leads/capture and admin lead retrieval via /api/admin/leads.
// Does NOT own: waitlist (routes/waitlist.js), promo codes (routes/promo-codes.js).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { captureLeadEmail, getLeads, getLeadsCount, getUnconvertedLeads } = require('../db/lead-magnets');
const { authenticateToken } = require('../middleware/auth');

function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

module.exports = function (pool) {
  // ── Public router: /api/leads/* ────────────────────────────────────────────
  const publicRouter = express.Router();

  // Rate limit: 20 capture requests per IP per hour
  const captureLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' }
  });

  // POST /api/leads/capture — public endpoint: capture email for lead magnet download.
  // Body: { email: string, lead_magnet_type: string, source_page?: string }
  publicRouter.post('/capture', captureLimiter, async (req, res) => {
    const { email, lead_magnet_type, source_page } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    const emailRegex = /^[^\t\n\r@]+@[^\t\n\r@]+\/[^\t\n\r@]+$/;
    if (emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    const validTypes = ['science_cheat_sheet', 'daily_three'];
    if (!lead_magnet_type || !validTypes.includes(lead_magnet_type)) {
      return res.status(400).json({ success: false, message: 'Invalid lead magnet type.' });
    }

    try {
      const result = await captureLeadEmail(pool, email.trim(), lead_magnet_type, source_page || null);
      return res.json({
        success: true,
        captured: result.new,
        message: result.new ? 'Email captured.' : 'Already captured.'
      });
    } catch (err) {
      console.error('[lead-magnets] capture error:', err.message);
      return res.status(500).json({ success: false, message: 'Server error, please try again.' });
    }
  });

  // ── Admin router: /api/admin/leads ──────────────────────────────────────────
  const adminRouter = express.Router();

  // GET /api/admin/leads — admin-only: retrieve captured leads with optional filtering.
  // Query params: ?type=science_cheat_sheet|daily_three&limit=100&offset=0
  adminRouter.get('/', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      // Admin gate (matches pattern used in routes/admin.js and routes/promo-codes.js)
      const adminCheck = await pool.query(
        'SELECT is_admin, email FROM users WHERE id = $1',
        [userId]
      );
      if (!adminCheck.rows[0] || !isAdminUser(adminCheck.rows[0])) {
        return res.status(403).json({ success: false, message: 'Admin access required.' });
      }

      const validTypes = ['science_cheat_sheet', 'daily_three'];
      const { type, limit = '100', offset = '0' } = req.query;
      const leadMagnetType = type && validTypes.includes(type) ? type : null;
      const parsedLimit = Math.min(parseInt(limit, 10) || 100, 500);
      const parsedOffset = parseInt(offset, 10) || 0;

      const [leads, total] = await Promise.all([
        getLeads(pool, leadMagnetType, parsedLimit, parsedOffset),
        getLeadsCount(pool, leadMagnetType)
      ]);
      return res.json({ success: true, leads, total, limit: parsedLimit, offset: parsedOffset });
    } catch (err) {
      console.error('[lead-magnets] get leads error:', err.message);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  // GET /api/admin/leads/unconverted — admin-only: leads with no matching user account.
  // Returns summary stats (total/counts/rate) + unconverted rows sorted by most recent.
  adminRouter.get('/unconverted', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const adminCheck = await pool.query(
        'SELECT is_admin, email FROM users WHERE id = $1',
        [userId]
      );
      if (!adminCheck.rows[0] || !isAdminUser(adminCheck.rows[0])) {
        return res.status(403).json({ success: false, message: 'Admin access required.' });
      }

      const { limit = '200', offset = '0' } = req.query;
      const parsedLimit = Math.min(parseInt(limit, 10) || 200, 500);
      const parsedOffset = parseInt(offset, 10) || 0;

      const [totalResult, unconvertedResult] = await Promise.all([
        getLeadsCount(pool, null),
        getUnconvertedLeads(pool, parsedLimit, parsedOffset)
      ]);

      const total = totalResult;
      const unconvertedCount = unconvertedResult.length;
      const converted = Math.max(0, total - unconvertedCount);
      const conversionRate = total > 0 ? parseFloat(((converted / total) * 100).toFixed(1)) : 0;

      return res.json({
        success: true,
        stats: { total, converted, unconverted: unconvertedCount, conversionRate },
        leads: unconvertedResult,
        limit: parsedLimit,
        offset: parsedOffset
      });
    } catch (err) {
      console.error('[lead-magnets] get unconverted leads error:', err.message);
      return res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  return { publicRouter, adminRouter };
};