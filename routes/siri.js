// routes/siri.js
// Owns: Siri Shortcuts API surface — today's focus read-back, task deep-link.
// Does NOT own: task CRUD, user auth, push notifications.
//
// Called by the iOS app's Siri Shortcuts handler. Responses are intentionally
// minimal — Siri reads them aloud, so every word is UX.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function (pool) {
  const router = express.Router();

  // All Siri routes require a valid JWT (stored in iOS Keychain, passed as Bearer).
  router.use(authenticateToken);

  // GET /api/siri/today-focus
  // Returns today's top 3 incomplete tasks in a Siri-readable shape.
  // Priority order: overdue first, then due-today, then no-due-date created today.
  // Capped at 3 — ADHD-friendly, not a wall of text.
  router.get('/today-focus', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localToday = getUserLocalDate(tz);

      const result = await pool.query(
        `SELECT id, title, due_date, due_time, priority
         FROM tasks
         WHERE user_id = $1
           AND is_completed = false
           AND (
             due_date::date <= $2::date
             OR (due_date IS NULL AND (created_at AT TIME ZONE $3)::date = $2::date)
           )
         ORDER BY
           CASE
             WHEN due_date::date < $2::date THEN 0   -- overdue first
             WHEN due_date::date = $2::date THEN 1   -- due today second
             ELSE 2                                   -- no-due-date created today last
           END ASC,
           due_time ASC NULLS LAST,
           created_at ASC
         LIMIT 3`,
        [userId, localToday, tz]
      );

      const tasks = result.rows;

      // Build the spoken string Siri reads aloud.
      // Short and punchy — ADHD users lose attention fast.
      let spokenText;
      if (tasks.length === 0) {
        spokenText = 'No tasks for today. Enjoy your day!';
      } else if (tasks.length === 1) {
        spokenText = `You have 1 task today: ${tasks[0].title}.`;
      } else {
        const titles = tasks.map((t, i) => `${i + 1}: ${t.title}`).join('. ');
        spokenText = `You have ${tasks.length} tasks today. ${titles}.`;
      }

      res.json({
        success: true,
        spoken_text: spokenText,
        task_count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          due_date: t.due_date,
          due_time: t.due_time,
        })),
      });
    } catch (err) {
      console.error('[siri] today-focus error:', err);
      res.status(500).json({
        success: false,
        spoken_text: "I couldn't reach FocusLedger right now. Try opening the app.",
        tasks: [],
      });
    }
  });

  // GET /api/siri/status
  // Lightweight liveness check — confirms token is valid.
  // Used by the iOS shortcut to validate auth before making the full request.
  router.get('/status', (req, res) => {
    res.json({ success: true, user_id: req.user.id, name: req.user.name });
  });

  return router;
};
