'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getUserLocalDate } = require('../lib/timezone');

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const tzRow = await pool.query(
        "SELECT COALESCE(timezone, 'UTC') AS tz, given_name FROM users WHERE id = $1",
        [userId]
      );
      const tz = tzRow.rows[0]?.tz || 'UTC';
      const name = tzRow.rows[0]?.given_name || null;
      const today = getUserLocalDate(tz);

      const d = new Date(today + 'T12:00:00Z');
      const dow = d.getUTCDay();
      const weekStart = new Date(d);
      weekStart.setUTCDate(d.getUTCDate() - dow + (dow === 0 ? -6 : 1));
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      // Gate: requires evening Buddy check-in from yesterday
      const yesterday = new Date(d);
      yesterday.setUTCDate(d.getUTCDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const [gateRow, userRow] = await Promise.all([
        pool.query(
          `SELECT 1 FROM buddy_checkins WHERE user_id = $1 AND checkin_type = 'evening'
           AND (created_at AT TIME ZONE $2)::date = $3::date LIMIT 1`,
          [userId, tz, yesterdayStr]
        ).catch(() => ({ rows: [] })),
        pool.query('SELECT created_at FROM users WHERE id = $1', [userId])
          .catch(() => ({ rows: [] })),
      ]);

      const hadCheckin = gateRow.rows.length > 0;
      const accountAgeDays = userRow.rows[0]
        ? (Date.now() - new Date(userRow.rows[0].created_at).getTime()) / 86400000
        : 999;

      if (!hadCheckin && accountAgeDays >= 2) {
        return res.json({
          success: true,
          locked: true,
          reason: 'evening_checkin',
          message: 'Complete your evening check-in to unlock tomorrow\'s brief',
          unlock_action: '/buddy',
        });
      }

      const [tasksRes, overdueRes, expenseRes, streakRes, doneRes] = await Promise.all([
        pool.query(
          'SELECT id, title FROM tasks WHERE user_id = $1 AND is_completed = false AND due_date = $2 ORDER BY created_at ASC LIMIT 5',
          [userId, today]
        ).catch(() => ({ rows: [] })),
        pool.query(
          'SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND is_completed = false AND due_date < $2',
          [userId, today]
        ).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(
          'SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE user_id = $1 AND expense_date >= $2',
          [userId, weekStartStr]
        ).catch(() => ({ rows: [{ total: 0 }] })),
        pool.query(
          `SELECT rs.current_streak, r.name FROM routine_streaks rs
           JOIN routines r ON r.id = rs.routine_id
           WHERE r.user_id = $1 AND rs.current_streak > 0
           ORDER BY rs.current_streak DESC LIMIT 1`,
          [userId]
        ).catch(() => ({ rows: [] })),
        pool.query(
          "SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND is_completed = true AND (updated_at AT TIME ZONE $2)::date = $3::date",
          [userId, tz, today]
        ).catch(() => ({ rows: [{ n: 0 }] })),
      ]);

      const tasksDue = tasksRes.rows;
      const overdueCount = parseInt(overdueRes.rows[0]?.n || 0, 10);
      const weekSpend = parseFloat(expenseRes.rows[0]?.total || 0);
      const bestStreak = streakRes.rows[0] || null;
      const completedToday = parseInt(doneRes.rows[0]?.n || 0, 10);

      let brief;
      if (completedToday >= 3) brief = 'Already in the zone — keep that momentum going.';
      else if (tasksDue.length === 0 && overdueCount === 0) brief = 'Nothing urgent today — a great day to get ahead.';
      else if (overdueCount > 0) brief = `${overdueCount} overdue task${overdueCount > 1 ? 's' : ''} waiting. Today's a good day to clear the backlog.`;
      else brief = `${tasksDue.length} task${tasksDue.length === 1 ? '' : 's'} ready for today. Let's make it count.`;

      res.json({
        success: true,
        date: today,
        name,
        brief,
        tasks_due_today: tasksDue.length,
        top_tasks: tasksDue.slice(0, 3),
        overdue_count: overdueCount,
        completed_today: completedToday,
        week_spending: Math.round(weekSpend * 100) / 100,
        best_streak: bestStreak ? { days: bestStreak.current_streak, name: bestStreak.name } : null,
      });
    } catch (err) {
      console.error('[daily-brief]', err.message);
      res.status(500).json({ success: false, message: 'Could not generate daily brief' });
    }
  });

  return router;
};
