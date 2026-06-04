const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// Admin emails from env var (comma-separated)
// Example: ADMIN_EMAILS=founder@example.com,admin@example.com
function isAdminUser(user) {
  if (user.is_admin) return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((user.email || '').toLowerCase());
}

// Calculate 3-day credit based on billing cycle
function calculateRewardCents(billingCycle) {
  if (billingCycle === 'annual') {
    // 3/365 × $100 = ~$0.82
    return Math.round((3 / 365) * 10000);
  }
  // Default: monthly — 3/30 × $9.99 = ~$1.00
  return Math.round((3 / 30) * 999);
}

module.exports = function(pool) {
  const router = express.Router();

  // GET all ideas (auth required — any user can browse)
  router.get('/', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const userRow = await pool.query('SELECT is_admin, email FROM users WHERE id = $1', [userId]);
      const user = userRow.rows[0] || {};
      const adminCheck = isAdminUser({ ...user, id: userId });

      const result = await pool.query(`
        SELECT
          fs.id,
          fs.user_id,
          fs.title,
          fs.description,
          fs.status,
          fs.reward_applied,
          fs.reward_amount_cents,
          fs.reward_notified,
          fs.created_at,
          u.name AS submitter_name
        FROM feature_suggestions fs
        JOIN users u ON fs.user_id = u.id
        ORDER BY
          CASE fs.status
            WHEN 'selected' THEN 1
            WHEN 'shipped' THEN 2
            WHEN 'under_review' THEN 3
            WHEN 'submitted' THEN 4
            ELSE 5
          END,
          fs.created_at DESC
      `);

      res.json({
        success: true,
        ideas: result.rows,
        current_user_id: userId,
        is_admin: adminCheck
      });
    } catch (err) {
      console.error('Error fetching ideas:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch ideas' });
    }
  });

  // POST submit new idea (auth required)
  router.post('/', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { title, description } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Title is required' });
      }
      if (title.length > 280) {
        return res.status(400).json({ success: false, message: 'Title too long (max 280 chars)' });
      }

      const result = await pool.query(
        `INSERT INTO feature_suggestions (user_id, title, description, status)
         VALUES ($1, $2, $3, 'submitted')
         RETURNING *`,
        [userId, title.trim(), (description || '').trim() || null]
      );

      res.json({ success: true, idea: result.rows[0] });
    } catch (err) {
      console.error('Error submitting idea:', err);
      res.status(500).json({ success: false, message: 'Failed to submit idea' });
    }
  });

  // DELETE own idea (auth required, own ideas only)
  router.delete('/:id', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const ideaId = parseInt(req.params.id);

      const check = await pool.query(
        'SELECT user_id FROM feature_suggestions WHERE id = $1',
        [ideaId]
      );
      if (!check.rows.length) {
        return res.status(404).json({ success: false, message: 'Idea not found' });
      }
      // Admins can delete any idea; users can only delete their own
      const userRow = await pool.query('SELECT is_admin, email FROM users WHERE id = $1', [userId]);
      const user = userRow.rows[0] || {};
      if (check.rows[0].user_id !== userId && !isAdminUser({ ...user, id: userId })) {
        return res.status(403).json({ success: false, message: 'Not your idea' });
      }

      await pool.query('DELETE FROM feature_suggestions WHERE id = $1', [ideaId]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting idea:', err);
      res.status(500).json({ success: false, message: 'Failed to delete idea' });
    }
  });

  // PATCH status (admin only)
  router.patch('/:id/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const ideaId = parseInt(req.params.id);
      const { status } = req.body;

      const validStatuses = ['submitted', 'under_review', 'selected', 'shipped'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }

      // Admin check
      const userRow = await pool.query('SELECT is_admin, email FROM users WHERE id = $1', [userId]);
      const user = userRow.rows[0] || {};
      if (!isAdminUser({ ...user, id: userId })) {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }

      // Fetch idea
      const ideaResult = await pool.query(
        'SELECT * FROM feature_suggestions WHERE id = $1',
        [ideaId]
      );
      if (!ideaResult.rows.length) {
        return res.status(404).json({ success: false, message: 'Idea not found' });
      }
      const idea = ideaResult.rows[0];

      let rewardAmountCents = idea.reward_amount_cents;
      let rewardApplied = idea.reward_applied;

      // If idea is being selected for the first time, apply reward
      if (status === 'selected' && idea.status !== 'selected' && !idea.reward_applied) {
        // Look up the submitter's subscription to calculate reward
        const subResult = await pool.query(
          `SELECT billing_cycle FROM app_subscription
           WHERE user_id = $1 AND plan = 'pro' AND status = 'active'
           ORDER BY id DESC LIMIT 1`,
          [idea.user_id]
        );

        const billing = subResult.rows[0];
        if (billing) {
          rewardAmountCents = calculateRewardCents(billing.billing_cycle);
          rewardApplied = true;
        } else {
          // Free user — give recognition but no monetary reward
          rewardAmountCents = 0;
          rewardApplied = false;
        }
      }

      const updated = await pool.query(
        `UPDATE feature_suggestions
         SET status = $1,
             reward_amount_cents = $2,
             reward_applied = $3,
             reward_notified = FALSE,
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, rewardAmountCents, rewardApplied, ideaId]
      );

      res.json({ success: true, idea: updated.rows[0] });
    } catch (err) {
      console.error('Error updating idea status:', err);
      res.status(500).json({ success: false, message: 'Failed to update status' });
    }
  });

  // POST mark reward notification as seen (auth, own ideas)
  router.post('/:id/ack-reward', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const ideaId = parseInt(req.params.id);

      await pool.query(
        `UPDATE feature_suggestions
         SET reward_notified = TRUE, updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [ideaId, userId]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('Error acking reward:', err);
      res.status(500).json({ success: false, message: 'Failed' });
    }
  });

  // GET pending reward notifications for current user
  router.get('/my-notifications', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await pool.query(
        `SELECT id, title, status, reward_amount_cents, reward_applied
         FROM feature_suggestions
         WHERE user_id = $1 AND status IN ('selected', 'shipped') AND reward_notified = FALSE`,
        [userId]
      );

      res.json({ success: true, notifications: result.rows });
    } catch (err) {
      console.error('Error fetching notifications:', err);
      res.status(500).json({ success: false, message: 'Failed' });
    }
  });

  return router;
};
