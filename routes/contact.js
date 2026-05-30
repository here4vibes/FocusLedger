// routes/contact.js
// Handles contact form submissions, in-app bug reports, and admin management.
// Does NOT own: user auth, email templates, subscription logic.
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { Resend } = require('resend');

const FROM_ADDRESS = 'FocusLedger <hello@focusledger.net>';

let resend = null;
function getResend() {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.error('[contact] RESEND_API_KEY not set'); return null; }
    resend = new Resend(apiKey);
  }
  return resend;
}

module.exports = function(pool) {
  const router = express.Router();

  // ── Helpers (inside factory so pool is in scope via closure) ───────────

  function isAdminUser(user) {
    if (user.is_admin) return true;
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    return adminEmails.includes((user.email || '').toLowerCase());
  }

  async function sendSupportNotification(submission) {
    const client = getResend();
    if (!client) return;

    const categoryLabel = {
      bug: '🐛 Bug Report',
      'account issue': '🔐 Account Issue',
      other: '💬 General',
    }[submission.category] || '💬 General';

    const userLine = submission.user_id ? `User ID: ${submission.user_id}` : 'Anonymous visitor';
    const pageLine = submission.page_url ? `\nPage: ${submission.page_url}` : '';
    const browserLine = submission.browser_info ? `\nBrowser: ${submission.browser_info}` : '';

    const subject = `[FocusLedger] ${categoryLabel} from ${submission.name || submission.email}`;
    const text = `${categoryLabel}\n\n` +
      `From: ${submission.name || 'N/A'} <${submission.email}>\n` +
      `${userLine}${pageLine}${browserLine}\n\n` +
      `Message:\n${submission.message}`;

    try {
      await client.emails.send({
        from: FROM_ADDRESS,
        to: ['hello@focusledger.net'],
        subject,
        text,
      });
    } catch (err) {
      console.error('[contact] Email send error:', err.message);
    }
  }

  // ── Admin gate helper ──────────────────────────────────────────────────

  async function requireAdmin(req) {
    const userRow = await pool.query(
      'SELECT is_admin, email FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userRow.rows[0] || {};
    return isAdminUser({ ...user, id: req.user.id, email: user.email });
  }

  // ── Public: Submit Contact Form ────────────────────────────────────────

  router.post('/submit', async (req, res) => {
    try {
      const { name, email, message, category } = req.body;

      if (!email || !message) {
        return res.status(400).json({ success: false, message: 'Email and message are required.' });
      }
      if (message.length > 5000) {
        return res.status(400).json({ success: false, message: 'Message is too long (max 5000 chars).' });
      }

      const validCategory = ['bug', 'account issue', 'other'].includes(category) ? category : 'other';

      const result = await pool.query(
        `INSERT INTO contact_submissions (name, email, message, category)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [name || null, email.trim().toLowerCase(), message.trim(), validCategory]
      );

      sendSupportNotification({ email, name: name || null, message, category: validCategory }).catch(() => {});

      res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
      console.error('[contact] Submit error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to submit. Please try again.' });
    }
  });

  // ── Authenticated: Submit Bug Report (in-app) ───────────────────────────

  router.post('/bug-report', authenticateToken, async (req, res) => {
    try {
      const { message, page_url, browser_info } = req.body;
      const userId = req.user.id;

      if (!message) {
        return res.status(400).json({ success: false, message: 'Description is required.' });
      }
      if (message.length > 2000) {
        return res.status(400).json({ success: false, message: 'Description is too long (max 2000 chars).' });
      }

      // $1 = userId used for both user_id column and WHERE; u.email/u.name pulled from users row
      const result = await pool.query(
        `INSERT INTO contact_submissions (user_id, email, name, message, category, page_url, browser_info)
         SELECT $1, u.email, u.name, $2, $3, $4, $5
         FROM users u WHERE u.id = $1
         RETURNING id`,
        [userId, message.trim(), 'bug', page_url || null, browser_info || null]
      );

      sendSupportNotification({
        email: req.user.email,
        name: req.user.name || null,
        message,
        category: 'bug',
        user_id: userId,
        page_url,
        browser_info,
      }).catch(() => {});

      res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
      console.error('[contact] Bug report error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to submit bug report.' });
    }
  });

  // ── Admin: List contact submissions ─────────────────────────────────────

  router.get('/admin/submissions', authenticateToken, async (req, res) => {
    try {
      if (!(await requireAdmin(req))) {
        return res.status(403).json({ success: false, message: 'Admin access required.' });
      }

      const { category, status, limit = 50, offset = 0 } = req.query;

      let query = `
        SELECT cs.*, u.name as user_name, u.email as user_email
        FROM contact_submissions cs
        LEFT JOIN users u ON u.id = cs.user_id
        WHERE 1=1
      `;
      const params = [];
      let i = 1;

      if (category && category !== 'all') { query += ` AND cs.category = $${i++}`; params.push(category); }
      if (status && status !== 'all') { query += ` AND cs.status = $${i++}`; params.push(status); }

      query += ` ORDER BY cs.created_at DESC LIMIT $${i++} OFFSET $${i++}`;
      params.push(parseInt(limit), parseInt(offset));

      // Build count query separately to avoid parameter ordering bugs
      let countQuery = 'SELECT COUNT(*)::int as total FROM contact_submissions';
      const countParams = [];
      let pi = 1;
      const conditions = [];
      if (category && category !== 'all') { conditions.push(`category = $${pi++}`); countParams.push(category); }
      if (status && status !== 'all') { conditions.push(`status = $${pi++}`); countParams.push(status); }
      if (conditions.length > 0) countQuery += ' WHERE ' + conditions.join(' AND ');

      const [subResult, countResult] = await Promise.all([
        pool.query(query, params),
        pool.query(countQuery, countParams),
      ]);

      res.json({ success: true, submissions: subResult.rows, total: countResult.rows[0]?.total || 0 });
    } catch (err) {
      console.error('[contact] Admin list error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch submissions.' });
    }
  });

  // ── Admin: Update submission status ────────────────────────────────────

  router.patch('/admin/submissions/:id/status', authenticateToken, async (req, res) => {
    try {
      if (!(await requireAdmin(req))) {
        return res.status(403).json({ success: false, message: 'Admin access required.' });
      }

      const { status } = req.body;
      if (!['pending', 'resolved'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status.' });
      }

      const result = await pool.query(
        `UPDATE contact_submissions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
        [status, req.params.id]
      );

      if (!result.rows[0]) {
        return res.status(404).json({ success: false, message: 'Submission not found.' });
      }

      res.json({ success: true, submission: result.rows[0] });
    } catch (err) {
      console.error('[contact] Admin update status error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update status.' });
    }
  });

  return router;
};