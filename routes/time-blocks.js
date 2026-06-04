/**
 * Time Blocks routes (calendar blocking tagged to values)
 * GET    /api/time-blocks                — list time blocks for current week
 * POST   /api/time-blocks                — create a time block
 * PATCH  /api/time-blocks/:id            — update a time block
 * DELETE /api/time-blocks/:id            — delete a time block
 * GET    /api/time-blocks/weekly-summary — hours per value for the week
 * GET    /api/time-blocks/tasks          — tasks with due dates for sidebar
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {
  router.use(authenticateToken);

  // GET weekly summary — hours blocked per value for the week
  router.get('/weekly-summary', async (req, res) => {
    try {
      const userId = req.user.id;
      // WHY: if no explicit date, use user's local date — not UTC
      const dateParam = req.query.date || getUserLocalDate(await fetchUserTimezone(pool, userId));
      const weekStart = getWeekStart(dateParam);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      // Hours blocked per value
      const blockedResult = await pool.query(
        `SELECT
           COALESCE(v.id::text, 'uncategorized') as value_id,
           COALESCE(v.value_name, 'Uncategorized') as value_name,
           COALESCE(v.color, '#94a3b8') as value_color,
           v.weekly_hours_target,
           SUM(
             EXTRACT(EPOCH FROM (tb.end_time - tb.start_time)) / 3600
           ) as hours_blocked
         FROM time_blocks tb
         LEFT JOIN user_values v ON tb.value_id = v.id
         WHERE tb.user_id = $1
           AND tb.block_date >= $2
           AND tb.block_date < $3
         GROUP BY v.id, v.value_name, v.color, v.weekly_hours_target
         ORDER BY hours_blocked DESC`,
        [userId, weekStart.toISOString().slice(0, 10), weekEnd.toISOString().slice(0, 10)]
      );

      // Total hours blocked this week
      const totalHours = blockedResult.rows.reduce((sum, r) => sum + parseFloat(r.hours_blocked || 0), 0);

      res.json({
        success: true,
        week_start: weekStart.toISOString().slice(0, 10),
        total_hours_blocked: Math.round(totalHours * 10) / 10,
        by_value: blockedResult.rows.map(r => ({
          ...r,
          hours_blocked: Math.round(parseFloat(r.hours_blocked || 0) * 10) / 10,
          weekly_hours_target: parseFloat(r.weekly_hours_target || 0)
        }))
      });
    } catch (err) {
      console.error('[TimeBlocks] Error fetching weekly summary:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch weekly summary' });
    }
  });

  // GET tasks for calendar sidebar (open tasks + tasks with due dates this week)
  router.get('/tasks', async (req, res) => {
    try {
      const userId = req.user.id;
      const dateParam = req.query.date || getUserLocalDate(await fetchUserTimezone(pool, userId));
      const weekStart = getWeekStart(dateParam);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const result = await pool.query(
        `SELECT t.id, t.title, t.due_date, t.value_id,
                v.value_name as value_name, v.color as value_color
         FROM tasks t
         LEFT JOIN user_values v ON t.value_id = v.id
         WHERE t.user_id = $1
           AND t.is_completed = false
         ORDER BY
           CASE WHEN t.due_date IS NOT NULL THEN 0 ELSE 1 END,
           t.due_date ASC NULLS LAST,
           t.created_at DESC
         LIMIT 50`,
        [userId]
      );

      res.json({ success: true, tasks: result.rows });
    } catch (err) {
      console.error('[TimeBlocks] Error fetching tasks:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
    }
  });

  // GET time blocks — defaults to current week; pass ?date=YYYY-MM-DD for a specific week
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const dateParam = req.query.date || getUserLocalDate(await fetchUserTimezone(pool, userId));
      const weekStart = getWeekStart(dateParam);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const result = await pool.query(
        `SELECT tb.*,
                v.value_name as value_name, v.color as value_color, v.rank as value_rank,
                t.title as task_title
         FROM time_blocks tb
         LEFT JOIN user_values v ON tb.value_id = v.id
         LEFT JOIN tasks t ON tb.task_id = t.id
         WHERE tb.user_id = $1
           AND tb.block_date >= $2
           AND tb.block_date < $3
         ORDER BY tb.block_date ASC, tb.start_time ASC`,
        [userId, weekStart.toISOString().slice(0, 10), weekEnd.toISOString().slice(0, 10)]
      );

      res.json({ success: true, time_blocks: result.rows });
    } catch (err) {
      console.error('[TimeBlocks] Error fetching:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch time blocks' });
    }
  });

  // POST create a time block
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { value_id, task_id, title, block_date, start_time, end_time } = req.body;

      if (!block_date || !start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'block_date, start_time, and end_time are required' });
      }

      if (start_time >= end_time) {
        return res.status(400).json({ success: false, message: 'start_time must be before end_time' });
      }

      // Enforce minimum 15-minute duration
      const [sh, sm] = start_time.split(':').map(Number);
      const [eh, em] = end_time.split(':').map(Number);
      if ((eh * 60 + em) - (sh * 60 + sm) < 15) {
        return res.status(400).json({ success: false, message: 'Time blocks must be at least 15 minutes.' });
      }

      // If task_id provided, verify it belongs to user and auto-inherit value
      let resolvedValueId = value_id ? parseInt(value_id) : null;
      let resolvedTitle = (title || '').trim().slice(0, 255) || null;

      if (task_id) {
        const taskResult = await pool.query(
          'SELECT id, title, value_id FROM tasks WHERE id = $1 AND user_id = $2',
          [parseInt(task_id), userId]
        );
        if (taskResult.rows.length > 0) {
          const task = taskResult.rows[0];
          // Auto-fill title from task if not provided
          if (!resolvedTitle) resolvedTitle = task.title;
          // Auto-inherit value from task if not overridden
          if (!resolvedValueId && task.value_id) resolvedValueId = task.value_id;
        }
      }

      const result = await pool.query(
        `INSERT INTO time_blocks (user_id, value_id, task_id, title, block_date, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          userId,
          resolvedValueId,
          task_id ? parseInt(task_id) : null,
          resolvedTitle,
          block_date,
          start_time,
          end_time
        ]
      );

      // Fetch with joins for complete response
      const full = await pool.query(
        `SELECT tb.*, v.value_name as value_name, v.color as value_color, t.title as task_title
         FROM time_blocks tb
         LEFT JOIN user_values v ON tb.value_id = v.id
         LEFT JOIN tasks t ON tb.task_id = t.id
         WHERE tb.id = $1`,
        [result.rows[0].id]
      );

      res.status(201).json({ success: true, time_block: full.rows[0] });
    } catch (err) {
      console.error('[TimeBlocks] Error creating:', err);
      res.status(500).json({ success: false, message: 'Failed to create time block' });
    }
  });

  // PATCH update a time block (title, value_id, start_time, end_time, block_date)
  router.patch('/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const blockId = parseInt(req.params.id);
      const { value_id, title, block_date, start_time, end_time } = req.body;

      // Verify ownership
      const existing = await pool.query(
        'SELECT * FROM time_blocks WHERE id = $1 AND user_id = $2',
        [blockId, userId]
      );
      if (existing.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Time block not found' });
      }

      const current = existing.rows[0];
      const newBlockDate = block_date || current.block_date;
      const newStartTime = start_time || current.start_time;
      const newEndTime = end_time || current.end_time;

      if (newStartTime >= newEndTime) {
        return res.status(400).json({ success: false, message: 'start_time must be before end_time' });
      }

      // Enforce minimum 15-minute duration
      const [psh, psm] = newStartTime.split(':').map(Number);
      const [peh, pem] = newEndTime.split(':').map(Number);
      if ((peh * 60 + pem) - (psh * 60 + psm) < 15) {
        return res.status(400).json({ success: false, message: 'Time blocks must be at least 15 minutes.' });
      }

      const result = await pool.query(
        `UPDATE time_blocks
         SET value_id    = $1,
             title       = $2,
             block_date  = $3,
             start_time  = $4,
             end_time    = $5,
             updated_at  = NOW()
         WHERE id = $6 AND user_id = $7
         RETURNING *`,
        [
          value_id !== undefined ? (value_id ? parseInt(value_id) : null) : current.value_id,
          title !== undefined ? ((title || '').trim().slice(0, 255) || null) : current.title,
          newBlockDate,
          newStartTime,
          newEndTime,
          blockId,
          userId
        ]
      );

      const full = await pool.query(
        `SELECT tb.*, v.value_name as value_name, v.color as value_color, t.title as task_title
         FROM time_blocks tb
         LEFT JOIN user_values v ON tb.value_id = v.id
         LEFT JOIN tasks t ON tb.task_id = t.id
         WHERE tb.id = $1`,
        [result.rows[0].id]
      );

      res.json({ success: true, time_block: full.rows[0] });
    } catch (err) {
      console.error('[TimeBlocks] Error updating:', err);
      res.status(500).json({ success: false, message: 'Failed to update time block' });
    }
  });

  // DELETE a time block
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM time_blocks WHERE id = $1 AND user_id = $2 RETURNING id',
        [req.params.id, req.user.id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Time block not found' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[TimeBlocks] Error deleting:', err);
      res.status(500).json({ success: false, message: 'Failed to delete time block' });
    }
  });

  // --- Helpers ---
  /** @param {string} [dateStr] — YYYY-MM-DD (user-local or explicit) */
  function getWeekStart(dateStr) {
    // WHY T12:00:00Z: avoids DST boundary issues when parsing a date string
    const ref = dateStr ? new Date(dateStr + 'T12:00:00Z') : new Date();
    const day = ref.getUTCDay(); // 0=Sunday
    const diff = ref.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(ref);
    monday.setUTCDate(diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday;
  }

  return router;
};
