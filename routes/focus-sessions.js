/**
 * routes/focus-sessions.js — Focus Mode session tracking API.
 *
 * Owns: POST /focus-sessions/start, POST /focus-sessions/:id/complete, GET /focus-sessions/recent
 * Does NOT own: task ownership verification (delegated to db queries that scope by user_id)
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  createSession,
  completeSession,
  getRecentSessions,
} = require('../db/focus-sessions');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // POST /api/v1/focus-sessions/start
  // Body: { task_id, planned_duration_minutes }
  router.post('/start', async (req, res) => {
    try {
      const userId = req.user.id;
      const { task_id, planned_duration_minutes } = req.body;

      if (!task_id) {
        return res.status(400).json({ success: false, message: 'task_id is required' });
      }
      const plannedMinutes = parseInt(planned_duration_minutes, 10) || 25;
      const plannedSeconds = plannedMinutes * 60;

      const session = await createSession(pool, {
        userId,
        taskId: task_id,
        plannedDurationSeconds: plannedSeconds,
      });

      res.json({ session_id: session.id });
    } catch (err) {
      console.error('[focus-sessions] start error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // POST /api/v1/focus-sessions/:id/complete
  // Body: { actual_duration_seconds, completed }
  router.post('/:id/complete', async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      const { actual_duration_seconds, completed } = req.body;

      if (actual_duration_seconds === undefined) {
        return res.status(400).json({ success: false, message: 'actual_duration_seconds is required' });
      }

      const result = await completeSession(pool, {
        sessionId: id,
        userId,
        actualDurationSeconds: parseInt(actual_duration_seconds, 10),
        completed: Boolean(completed),
      });

      if (!result) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[focus-sessions] complete error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // GET /api/v1/focus-sessions/recent
  // Returns last 10 sessions for stats display
  router.get('/recent', async (req, res) => {
    try {
      const userId = req.user.id;
      const sessions = await getRecentSessions(pool, userId, 10);
      res.json({ sessions });
    } catch (err) {
      console.error('[focus-sessions] recent error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // POST /api/v1/focus-sessions/:id/break
  // Manually trigger a movement break nudge for an active session.
  // Does not interrupt the session — just sends the nudge.
  router.post('/:id/break', async (req, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;

      // Verify session belongs to user and is still active
      const session = await pool.query(`
        SELECT id FROM focus_sessions
        WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
      `, [id, userId]);

      if (!session.rows.length) {
        return res.status(404).json({
          success: false,
          message: 'No active focus session found',
        });
      }

      const { generateMovementBreakNudge } = require('../lib/nudgeGenerator');
      const { created, id: nudgeId } = await generateMovementBreakNudge(pool, userId, id);

      res.json({ success: true, nudge_created: created, nudge_id: nudgeId });
    } catch (err) {
      console.error('[focus-sessions] break trigger error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // GET /api/v1/focus-sessions/next
  // Returns the best task to focus on next (overdue → due today → created today)
  router.get('/next', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(`
        SELECT id, title, due_date, due_time, duration_minutes
        FROM tasks
        WHERE user_id = $1
          AND is_completed = false
          AND archived = false
          AND (due_date IS NULL OR due_date <= CURRENT_DATE + INTERVAL '7 days')
        ORDER BY
          CASE WHEN due_date < CURRENT_DATE THEN 0 ELSE 1 END ASC,
          due_date ASC NULLS LAST,
          due_time ASC NULLS LAST,
          created_at ASC
        LIMIT 1
      `, [userId]);

      if (!result.rows.length) {
        return res.json({ success: true, task: null, message: 'No tasks available for focus' });
      }

      res.json({ success: true, task: result.rows[0] });
    } catch (err) {
      console.error('[focus-sessions] /next error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
};