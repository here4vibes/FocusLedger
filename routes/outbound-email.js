'use strict';
/**
 * Outbound Email Routes
 *
 * GET /api/outbound-email/track/:logId   — open tracking pixel
 * GET /api/outbound-email/unsubscribe/:userId/:type — unsubscribe link
 * GET /api/outbound-email/preferences    — get preferences (authed)
 * PUT /api/outbound-email/preferences    — update preferences (authed)
 *
 * Admin:
 * GET /api/outbound-email/log            — paginated email log (admin only)
 * GET /api/outbound-email/log/stats      — summary stats (admin only)
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// 1×1 transparent GIF
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

module.exports = function(pool) {
  const router = express.Router();

  // ─── Open Tracking Pixel ────────────────────────────────────────────────────
  // GET /api/outbound-email/track/:logId
  // Always returns a 1x1 transparent GIF. Updates opened_at on first open only.
  router.get('/track/:logId', async (req, res) => {
    const logId = parseInt(req.params.logId, 10);
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.send(PIXEL_GIF);

    // Fire-and-forget: update opened_at only on first open
    if (!isNaN(logId)) {
      pool.query(
        `UPDATE email_log
         SET status = CASE WHEN status = 'sent' OR status = 'delivered' THEN 'opened' ELSE status END,
             opened_at = CASE WHEN opened_at IS NULL THEN NOW() ELSE opened_at END
         WHERE id = $1`,
        [logId]
      ).catch((err) => {
        console.error('[outbound-email] Failed to update open tracking:', err.message);
      });
    }
  });

  // ─── Unsubscribe ─────────────────────────────────────────────────────────────
  // GET /api/outbound-email/unsubscribe/:userId/:type
  router.get('/unsubscribe/:userId/:type', async (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    const type = req.params.type;

    const validTypes = ['weekly_nudge', 're_engagement', 'welcome'];
    if (!validTypes.includes(type) || isNaN(userId)) {
      return res.status(400).send('<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h2>Invalid unsubscribe link.</h2></body></html>');
    }

    // welcome emails are one-time; unsubscribe just opts out of all marketing emails
    const effectiveType = type === 'welcome' ? null : type;

    const typeLabel = {
      weekly_nudge: 'weekly nudge',
      re_engagement: 're-engagement',
      welcome: 'all FocusLedger'
    }[type] || type;

    try {
      if (effectiveType) {
        // Upsert preferences with this type set to false
        await pool.query(
          `INSERT INTO user_email_preferences (user_id, ${effectiveType})
           VALUES ($1, false)
           ON CONFLICT (user_id) DO UPDATE SET ${effectiveType} = false, updated_at = NOW()`,
          [userId]
        );
      } else {
        // welcome unsubscribe → opt out of all marketing emails
        await pool.query(
          `INSERT INTO user_email_preferences (user_id, weekly_nudge, re_engagement)
           VALUES ($1, false, false)
           ON CONFLICT (user_id) DO UPDATE SET weekly_nudge = false, re_engagement = false, updated_at = NOW()`,
          [userId]
        );
      }

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Unsubscribed — FocusLedger</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>
        <body style="font-family:system-ui,-apple-system,sans-serif;background:#FAF9F6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
          <div style="text-align:center;padding:40px 24px;max-width:420px;">
            <div style="width:11px;height:11px;background:#E8913A;border-radius:3px;transform:rotate(45deg);display:inline-block;margin-bottom:16px;"></div>
            <h1 style="font-size:1.5rem;font-weight:700;color:#2D2A26;margin:0 0 12px;">Done.</h1>
            <p style="color:#4D4A46;margin:0 0 24px;font-size:15px;line-height:1.6;">
              You've been unsubscribed from ${typeLabel} emails.
              You can update these preferences anytime in your settings.
            </p>
            <a href="/app/tasks" style="display:inline-block;padding:12px 24px;background:#E8913A;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
              Back to FocusLedger
            </a>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      console.error('[outbound-email] Unsubscribe error:', err.message);
      res.status(500).send('<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h2>Something went wrong. Please try again.</h2></body></html>');
    }
  });

  // ─── Get Preferences (authenticated) ─────────────────────────────────────────
  router.get('/preferences', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT weekly_nudge, re_engagement FROM user_email_preferences WHERE user_id = $1',
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.json({ success: true, preferences: { weekly_nudge: true, re_engagement: true } });
      }
      res.json({ success: true, preferences: result.rows[0] });
    } catch (err) {
      console.error('[outbound-email] Get preferences error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch preferences' });
    }
  });

  // ─── Update Preferences (authenticated) ──────────────────────────────────────
  router.put('/preferences', authenticateToken, async (req, res) => {
    const { weekly_nudge, re_engagement } = req.body;
    if (typeof weekly_nudge !== 'boolean' && typeof re_engagement !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Provide weekly_nudge and/or re_engagement as boolean' });
    }

    try {
      // Upsert defaults then update provided fields
      const wn = typeof weekly_nudge === 'boolean' ? weekly_nudge : true;
      const re = typeof re_engagement === 'boolean' ? re_engagement : true;

      await pool.query(
        `INSERT INTO user_email_preferences (user_id, weekly_nudge, re_engagement)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET weekly_nudge  = COALESCE($2, user_email_preferences.weekly_nudge),
               re_engagement = COALESCE($3, user_email_preferences.re_engagement),
               updated_at    = NOW()`,
        [req.user.id, typeof weekly_nudge === 'boolean' ? weekly_nudge : null, typeof re_engagement === 'boolean' ? re_engagement : null]
      );

      // Re-fetch actual values
      const updated = await pool.query(
        'SELECT weekly_nudge, re_engagement FROM user_email_preferences WHERE user_id = $1',
        [req.user.id]
      );
      res.json({ success: true, preferences: updated.rows[0] || { weekly_nudge: wn, re_engagement: re } });
    } catch (err) {
      console.error('[outbound-email] Update preferences error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
  });

  // ─── Admin: Email Log ─────────────────────────────────────────────────────────
  // GET /api/outbound-email/log?page=1&limit=50&template_type=welcome&status=sent&from=&to=
  router.get('/log', authenticateToken, async (req, res) => {
    try {
      const userRow = await pool.query('SELECT is_admin, email FROM users WHERE id = $1', [req.user.id]);
      const user = userRow.rows[0] || {};
      if (!isAdminUser({ ...user, id: req.user.id })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;

      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (req.query.template_type) {
        conditions.push(`el.template_type = $${paramIndex++}`);
        params.push(req.query.template_type);
      }
      if (req.query.status) {
        conditions.push(`el.status = $${paramIndex++}`);
        params.push(req.query.status);
      }
      if (req.query.from) {
        conditions.push(`el.created_at >= $${paramIndex++}`);
        params.push(req.query.from);
      }
      if (req.query.to) {
        conditions.push(`el.created_at <= $${paramIndex++}`);
        params.push(req.query.to + 'T23:59:59Z');
      }

      const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM email_log el ${where}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const rows = await pool.query(
        `SELECT
           el.id,
           el.user_id,
           u.email AS user_email,
           u.name  AS user_name,
           el.to_email,
           el.subject,
           el.template_type,
           el.status,
           el.resend_message_id,
           el.opened_at,
           el.sent_at,
           el.created_at
         FROM email_log el
         LEFT JOIN users u ON u.id = el.user_id
         ${where}
         ORDER BY el.created_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      res.json({
        success: true,
        data: rows.rows,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      console.error('[outbound-email] Log error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch email log' });
    }
  });

  // GET /api/outbound-email/log/stats — summary stats for admin dashboard
  router.get('/log/stats', authenticateToken, async (req, res) => {
    try {
      const userRow = await pool.query('SELECT is_admin, email FROM users WHERE id = $1', [req.user.id]);
      const user = userRow.rows[0] || {};
      if (!isAdminUser({ ...user, id: req.user.id })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS sent_30d,
          COUNT(*) FILTER (WHERE opened_at IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days') AS opened_30d,
          COUNT(*) FILTER (WHERE status = 'bounced' AND created_at >= NOW() - INTERVAL '30 days') AS bounced_30d,
          COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '30 days') AS failed_30d,
          COUNT(*) FILTER (WHERE template_type = 'welcome') AS total_welcome,
          COUNT(*) FILTER (WHERE template_type = 'weekly_nudge') AS total_weekly_nudge,
          COUNT(*) FILTER (WHERE template_type = 're_engagement') AS total_re_engagement
        FROM email_log
      `);

      const row = stats.rows[0];
      const sent30d = parseInt(row.sent_30d, 10) || 0;
      const opened30d = parseInt(row.opened_30d, 10) || 0;
      const bounced30d = parseInt(row.bounced_30d, 10) || 0;

      res.json({
        success: true,
        stats: {
          sent_30d: sent30d,
          opened_30d: opened30d,
          bounced_30d: bounced30d,
          failed_30d: parseInt(row.failed_30d, 10) || 0,
          open_rate_30d: sent30d > 0 ? Math.round((opened30d / sent30d) * 100) : 0,
          bounce_rate_30d: sent30d > 0 ? Math.round((bounced30d / sent30d) * 100) : 0,
          total_by_type: {
            welcome: parseInt(row.total_welcome, 10) || 0,
            weekly_nudge: parseInt(row.total_weekly_nudge, 10) || 0,
            re_engagement: parseInt(row.total_re_engagement, 10) || 0
          }
        }
      });
    } catch (err) {
      console.error('[outbound-email] Stats error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  });

  return router;
};
