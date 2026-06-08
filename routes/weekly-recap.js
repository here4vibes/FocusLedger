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
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
      const ws = weekStart.toISOString().slice(0, 10);
      const we = weekEnd.toISOString().slice(0, 10);

      // Gate: requires at least one classified expense this week
      // Only applies if the user has expenses at all (i.e. bank connected or manual entries)
      const [classifiedRow, anyExpenseRow] = await Promise.all([
        pool.query(
          'SELECT 1 FROM expenses WHERE user_id = $1 AND expense_date >= $2 AND is_impulse IS NOT NULL LIMIT 1',
          [userId, ws]
        ).catch(() => ({ rows: [] })),
        pool.query('SELECT 1 FROM expenses WHERE user_id = $1 LIMIT 1', [userId])
          .catch(() => ({ rows: [] })),
      ]);

      if (anyExpenseRow.rows.length > 0 && classifiedRow.rows.length === 0) {
        return res.json({
          success: true,
          locked: true,
          reason: 'spending_classification',
          message: 'Review at least one expense this week to unlock your Executive Summary',
          unlock_action: '/money',
        });
      }

      const [tasksRes, expensesRes, streakRes, checkinRes, impulseRes, focusRes] = await Promise.all([
        pool.query(
          "SELECT COUNT(*) AS n FROM tasks WHERE user_id = $1 AND is_completed = true AND (updated_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date",
          [userId, tz, ws, we]
        ).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(
          'SELECT c.name AS category, SUM(e.amount) AS total FROM expenses e LEFT JOIN categories c ON c.id = e.category_id WHERE e.user_id = $1 AND e.expense_date BETWEEN $2 AND $3 GROUP BY c.name ORDER BY total DESC',
          [userId, ws, we]
        ).catch(() => ({ rows: [] })),
        pool.query(
          'SELECT rs.current_streak, rs.best_streak, r.name FROM routine_streaks rs JOIN routines r ON r.id = rs.routine_id WHERE r.user_id = $1 ORDER BY rs.current_streak DESC LIMIT 1',
          [userId]
        ).catch(() => ({ rows: [] })),
        pool.query(
          "SELECT COUNT(*) AS n FROM buddy_checkins WHERE user_id = $1 AND (created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date",
          [userId, tz, ws, we]
        ).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(
          'SELECT COUNT(*) AS n FROM expenses WHERE user_id = $1 AND expense_date BETWEEN $2 AND $3 AND is_impulse = true',
          [userId, ws, we]
        ).catch(() => ({ rows: [{ n: 0 }] })),
        pool.query(
          "SELECT COUNT(*) AS sessions, COALESCE(SUM(actual_duration_seconds), 0) AS total_seconds FROM focus_sessions WHERE user_id = $1 AND started_at::date BETWEEN $2::date AND $3::date AND completed = true",
          [userId, ws, we]
        ).catch(() => ({ rows: [{ sessions: 0, total_seconds: 0 }] })),
      ]);

      const tasksCompleted = parseInt(tasksRes.rows[0]?.n || 0, 10);
      const totalSpending = expensesRes.rows.reduce((s, r) => s + parseFloat(r.total || 0), 0);
      const streak = streakRes.rows[0] || null;
      const checkins = parseInt(checkinRes.rows[0]?.n || 0, 10);
      const impulseCount = parseInt(impulseRes.rows[0]?.n || 0, 10);
      const focusSessions = parseInt(focusRes.rows[0]?.sessions || 0, 10);
      const focusMinutes = Math.round(parseInt(focusRes.rows[0]?.total_seconds || 0, 10) / 60);

      res.json({
        success: true,
        week_start: ws,
        week_end: we,
        name,
        tasks_completed: tasksCompleted,
        total_spending: Math.round(totalSpending * 100) / 100,
        spending_breakdown: expensesRes.rows.map(r => ({
          category: r.category || 'Other',
          total: Math.round(parseFloat(r.total) * 100) / 100,
        })),
        streak: streak ? { days: streak.current_streak, best: streak.best_streak, routine: streak.name } : null,
        buddy_checkins: checkins,
        impulse_count: impulseCount,
        focus_sessions: focusSessions,
        focus_minutes: focusMinutes,
      });
    } catch (err) {
      console.error('[weekly-recap]', err.message);
      res.status(500).json({ success: false, message: 'Could not generate recap' });
    }
  });

  return router;
};
