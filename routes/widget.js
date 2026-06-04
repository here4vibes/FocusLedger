// Widget API — owns the read-only task feed consumed by the iOS WidgetKit extension.
// Does NOT own task creation, mutation, or any other task logic (routes/tasks.js does).
// All auth uses the same JWT middleware as the main app — no separate token scheme.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { getTodayWidgetTasks } = require('../db/widget');

module.exports = function (pool) {
  const router = express.Router();

  // GET /api/widget/tasks
  // Returns the top 3 "today's focus" tasks for the authenticated user.
  // Prioritization: overdue incomplete → due today incomplete → created today incomplete.
  // Caps at 3 — widget only has room for 3, and ADHD users benefit from a hard limit.
  router.get('/tasks', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localToday = getUserLocalDate(tz);

      const tasks = await getTodayWidgetTasks(pool, userId, localToday, tz);

      res.json({
        success: true,
        tasks,
        today: localToday,
        // Widget uses this to know when to clear — after midnight in user's timezone
        refreshAfter: localToday + 'T23:59:59',
      });
    } catch (err) {
      console.error('[widget] Error fetching widget tasks:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch widget tasks' });
    }
  });

  return router;
};
