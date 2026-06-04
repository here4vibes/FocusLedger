/**
 * Values Profile routes
 * GET    /api/values              — list user's values
 * POST   /api/values              — create a single value
 * PUT    /api/values/:id          — update a single value
 * DELETE /api/values/:id          — delete a value
 * POST   /api/values/reorder      — reorder values
 * GET    /api/values/week-snapshot — weekly progress data
 * GET    /api/values/setup-status  — setup prompt tracking
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET all values for current user
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, user_id, value_name, rank, icon, color,
                weekly_hours_target, weekly_spend_target,
                created_at, updated_at
         FROM user_values
         WHERE user_id = $1
         ORDER BY rank ASC`,
        [req.user.id]
      );
      res.json({ success: true, values: result.rows });
    } catch (err) {
      console.error('[Values] Error fetching values:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch values' });
    }
  });

  // POST create a single value
  router.post('/', async (req, res) => {
    try {
      const { value_name, icon, color, weekly_hours_target, weekly_spend_target } = req.body;
      const name = (value_name || '').trim().slice(0, 100);
      if (!name) {
        return res.status(400).json({ success: false, message: 'value_name is required' });
      }

      const userId = req.user.id;

      // Check limit: max 10 values
      const countResult = await pool.query(
        'SELECT COUNT(*) as cnt FROM user_values WHERE user_id = $1',
        [userId]
      );
      if (parseInt(countResult.rows[0].cnt) >= 10) {
        return res.status(400).json({ success: false, message: 'Maximum 10 values allowed' });
      }

      // Get next rank
      const rankResult = await pool.query(
        'SELECT COALESCE(MAX(rank), 0) + 1 as next_rank FROM user_values WHERE user_id = $1',
        [userId]
      );
      const nextRank = rankResult.rows[0].next_rank;

      const result = await pool.query(
        `INSERT INTO user_values
           (user_id, value_name, rank, icon, color, weekly_hours_target, weekly_spend_target)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          userId,
          name,
          nextRank,
          icon || '⭐',
          color || '#F26B3A',
          parseFloat(weekly_hours_target) || null,
          parseFloat(weekly_spend_target) || null
        ]
      );

      res.json({ success: true, value: result.rows[0] });
    } catch (err) {
      console.error('[Values] Error creating value:', err);
      res.status(500).json({ success: false, message: 'Failed to create value' });
    }
  });

  // PUT update a single value
  router.put('/:id', async (req, res) => {
    try {
      const { value_name, icon, color, weekly_hours_target, weekly_spend_target } = req.body;
      const name = (value_name || '').trim().slice(0, 100);
      if (!name) {
        return res.status(400).json({ success: false, message: 'value_name is required' });
      }

      const result = await pool.query(
        `UPDATE user_values
         SET value_name = $1, icon = $2, color = $3,
             weekly_hours_target = $4, weekly_spend_target = $5,
             updated_at = NOW()
         WHERE id = $6 AND user_id = $7
         RETURNING *`,
        [
          name,
          icon || '⭐',
          color || '#F26B3A',
          parseFloat(weekly_hours_target) || null,
          parseFloat(weekly_spend_target) || null,
          req.params.id,
          req.user.id
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Value not found' });
      }

      res.json({ success: true, value: result.rows[0] });
    } catch (err) {
      console.error('[Values] Error updating value:', err);
      res.status(500).json({ success: false, message: 'Failed to update value' });
    }
  });

  // DELETE a single value
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM user_values WHERE id = $1 AND user_id = $2 RETURNING id',
        [req.params.id, req.user.id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Value not found' });
      }

      // Re-rank remaining values
      await pool.query(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY rank) as new_rank
           FROM user_values WHERE user_id = $1
         )
         UPDATE user_values SET rank = ranked.new_rank
         FROM ranked WHERE user_values.id = ranked.id`,
        [req.user.id]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('[Values] Error deleting value:', err);
      res.status(500).json({ success: false, message: 'Failed to delete value' });
    }
  });

  // POST reorder values
  router.post('/reorder', async (req, res) => {
    try {
      const { order } = req.body; // array of value IDs in desired order
      if (!Array.isArray(order)) {
        return res.status(400).json({ success: false, message: 'order array is required' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < order.length; i++) {
          await client.query(
            'UPDATE user_values SET rank = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
            [i + 1, order[i], req.user.id]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[Values] Error reordering values:', err);
      res.status(500).json({ success: false, message: 'Failed to reorder values' });
    }
  });

  // GET week snapshot — returns this week's progress per value
  router.get('/week-snapshot', async (req, res) => {
    try {
      const userId = req.user.id;

      // Get all user values
      const valuesResult = await pool.query(
        'SELECT id, weekly_hours_target, weekly_spend_target FROM user_values WHERE user_id = $1',
        [userId]
      );

      // Calculate week start (Monday)
      const now = new Date();
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() + mondayOffset);
      weekStart.setHours(0, 0, 0, 0);

      // Get time blocks for this week
      const hoursMap = {};
      try {
        const timeResult = await pool.query(
          `SELECT value_id,
                  SUM(EXTRACT(EPOCH FROM (end_time - start_time)) / 3600) as total_hours
           FROM time_blocks
           WHERE user_id = $1 AND block_date >= $2 AND value_id IS NOT NULL
           GROUP BY value_id`,
          [userId, weekStart.toISOString().split('T')[0]]
        );
        timeResult.rows.forEach(r => {
          hoursMap[r.value_id] = parseFloat(r.total_hours) || 0;
        });
      } catch (_e) {
        // time_blocks table might not exist yet — that's fine
      }

      // Get expenses for this week tagged to values
      const spendMap = {};
      try {
        const spendResult = await pool.query(
          `SELECT t.value_id,
                  SUM(e.amount) as total_spend
           FROM expenses e
           JOIN tasks t ON e.task_id = t.id
           WHERE e.user_id = $1 AND e.created_at >= $2 AND t.value_id IS NOT NULL
           GROUP BY t.value_id`,
          [userId, weekStart.toISOString()]
        );
        spendResult.rows.forEach(r => {
          spendMap[r.value_id] = parseFloat(r.total_spend) || 0;
        });
      } catch (_e) {
        // expenses might not have task_id — that's fine, return zeros
      }

      const snapshot = valuesResult.rows.map(v => ({
        id: v.id,
        hours_this_week: hoursMap[v.id] || 0,
        spend_this_week: spendMap[v.id] || 0
      }));

      res.json({ success: true, snapshot });
    } catch (err) {
      console.error('[Values] Error fetching week snapshot:', err);
      res.json({ success: true, snapshot: [] });
    }
  });

  // GET setup status — track whether user has seen/skipped the values prompt
  router.get('/setup-status', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT values_setup_skipped_count, values_banner_dismissed_at FROM users WHERE id = $1',
        [req.user.id]
      );
      const skipped = result.rows[0]?.values_setup_skipped_count || 0;
      const dismissedAt = result.rows[0]?.values_banner_dismissed_at || null;

      const valuesCount = await pool.query(
        'SELECT COUNT(*) as cnt FROM user_values WHERE user_id = $1',
        [req.user.id]
      );
      const hasValues = parseInt(valuesCount.rows[0].cnt) > 0;

      // Show onboarding explainer if never permanently dismissed.
      // Separate from the "no values yet" prompt — this explains the feature
      // to any user who hasn't seen it, regardless of whether they have values.
      const onboardingDismissed = !!dismissedAt;
      const showOnboarding = !onboardingDismissed;

      // Legacy: show setup prompt only if no values and not recently dismissed
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const dismissedRecently = dismissedAt && (Date.now() - new Date(dismissedAt).getTime() < sevenDaysMs);
      const showPrompt = !hasValues && !dismissedRecently;

      res.json({
        success: true,
        has_values: hasValues,
        skipped_count: skipped,
        show_prompt: showPrompt,
        show_onboarding: showOnboarding
      });
    } catch (err) {
      console.error('[Values] Error fetching setup status:', err);
      res.json({ success: true, has_values: false, skipped_count: 0, show_prompt: true, show_onboarding: true });
    }
  });

  // POST dismiss-banner — record that user dismissed the values banner
  router.post('/dismiss-banner', async (req, res) => {
    try {
      await pool.query(
        `UPDATE users
         SET values_banner_dismissed_at = NOW(),
             values_setup_skipped_count = COALESCE(values_setup_skipped_count, 0) + 1
         WHERE id = $1`,
        [req.user.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[Values] Error dismissing banner:', err);
      res.status(500).json({ success: false, message: 'Failed to record dismissal' });
    }
  });

  // POST bulk — create multiple values at once (used by quick-pick onboarding flow)
  router.post('/bulk', async (req, res) => {
    try {
      const { values } = req.body; // array of { value_name, icon }
      if (!Array.isArray(values) || values.length === 0) {
        return res.status(400).json({ success: false, message: 'values array is required' });
      }

      const userId = req.user.id;

      // Check existing count
      const countResult = await pool.query(
        'SELECT COUNT(*) as cnt FROM user_values WHERE user_id = $1',
        [userId]
      );
      const existing = parseInt(countResult.rows[0].cnt);
      if (existing + values.length > 10) {
        return res.status(400).json({ success: false, message: 'Would exceed 10-value limit' });
      }

      const rankResult = await pool.query(
        'SELECT COALESCE(MAX(rank), 0) as max_rank FROM user_values WHERE user_id = $1',
        [userId]
      );
      let nextRank = parseInt(rankResult.rows[0].max_rank) + 1;

      const created = [];
      for (const v of values) {
        const name = (v.value_name || '').trim().slice(0, 100);
        if (!name) continue;
        const result = await pool.query(
          `INSERT INTO user_values (user_id, value_name, rank, icon, color)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [userId, name, nextRank++, v.icon || '⭐', v.color || '#F26B3A']
        );
        created.push(result.rows[0]);
      }

      res.json({ success: true, values: created });
    } catch (err) {
      console.error('[Values] Error bulk-creating values:', err);
      res.status(500).json({ success: false, message: 'Failed to create values' });
    }
  });

  return router;
};
