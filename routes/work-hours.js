/**
 * Work Hours Routes
 * Owns: work_hour_blocks table — user-defined blocked/unavailable time slots.
 * Does NOT own: tasks, time_blocks, or scheduling logic (future module).
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/work-hours — return all blocks for the current user
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(
        `SELECT id, day_of_week, start_time, end_time, label
         FROM work_hour_blocks
         WHERE user_id = $1
         ORDER BY day_of_week ASC, start_time ASC`,
        [userId]
      );
      res.json({ success: true, blocks: result.rows });
    } catch (_err) {
      res.status(500).json({ success: false, message: 'Failed to load work hours' });
    }
  });

  // POST /api/work-hours — create a new block
  // Body: { day_of_week: 0-6, start_time: "HH:MM", end_time: "HH:MM", label?: string }
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { day_of_week, start_time, end_time, label } = req.body;

      if (day_of_week === undefined || day_of_week < 0 || day_of_week > 6) {
        return res.status(400).json({ success: false, message: 'day_of_week must be 0–6' });
      }
      if (!start_time || !end_time) {
        return res.status(400).json({ success: false, message: 'start_time and end_time are required' });
      }
      if (start_time >= end_time) {
        return res.status(400).json({ success: false, message: 'end_time must be after start_time' });
      }

      const result = await pool.query(
        `INSERT INTO work_hour_blocks (user_id, day_of_week, start_time, end_time, label)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [userId, parseInt(day_of_week), start_time, end_time, label || null]
      );
      res.status(201).json({ success: true, block: result.rows[0] });
    } catch (_err) {
      res.status(500).json({ success: false, message: 'Failed to save work hours block' });
    }
  });

  // DELETE /api/work-hours/:id — remove a block
  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      const result = await pool.query(
        'DELETE FROM work_hour_blocks WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Block not found' });
      }
      res.json({ success: true });
    } catch (_err) {
      res.status(500).json({ success: false, message: 'Failed to delete work hours block' });
    }
  });

  // PUT /api/work-hours — replace all blocks for the user (bulk update)
  // Body: { blocks: [{ day_of_week, start_time, end_time, label }] }
  router.put('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { blocks } = req.body;

      if (!Array.isArray(blocks)) {
        return res.status(400).json({ success: false, message: 'blocks must be an array' });
      }

      for (const b of blocks) {
        if (b.day_of_week === undefined || b.day_of_week < 0 || b.day_of_week > 6) {
          return res.status(400).json({ success: false, message: 'day_of_week must be 0–6' });
        }
        if (!b.start_time || !b.end_time) {
          return res.status(400).json({ success: false, message: 'start_time and end_time required for each block' });
        }
        if (b.start_time >= b.end_time) {
          return res.status(400).json({ success: false, message: 'end_time must be after start_time' });
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM work_hour_blocks WHERE user_id = $1', [userId]);
        const saved = [];
        for (const b of blocks) {
          const r = await client.query(
            `INSERT INTO work_hour_blocks (user_id, day_of_week, start_time, end_time, label)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [userId, parseInt(b.day_of_week), b.start_time, b.end_time, b.label || null]
          );
          saved.push(r.rows[0]);
        }
        await client.query('COMMIT');
        res.json({ success: true, blocks: saved });
      } catch (_err) {
        await client.query('ROLLBACK');
        throw _err;
      } finally {
        client.release();
      }
    } catch (_err) {
      res.status(500).json({ success: false, message: 'Failed to save work hours' });
    }
  });

  return router;
};
