'use strict';
// Owns: the Today Timeline aggregate — tasks + time blocks + focus session +
// calibration for the user's local date, in one payload.
// Does NOT own: task CRUD (tasks-prisma), block CRUD (time-blocks),
// estimation math (services/TimeEstimationService).
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const TimeEstimationService = require('../services/TimeEstimationService');

// Calibration ratios outside this range are noise (too few samples, one wild
// task) — clamp so a block never renders at 10x its estimate.
function clampRatio(r) {
  if (!r || !Number.isFinite(r)) return 1;
  return Math.min(3, Math.max(0.5, r));
}

module.exports = function (pool) {
  const router = express.Router();

  // GET /api/today/timeline — everything the Today view needs in one call
  router.get('/timeline', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);

      const [tasksResult, blocksResult, focusResult, calibration] = await Promise.all([
        pool.query(
          `SELECT id, title, due_time, duration_minutes, is_completed
           FROM tasks
           WHERE user_id = $1 AND is_completed = false
             AND (due_date = $2::date OR (due_date < $2::date AND due_date >= $2::date - INTERVAL '7 days'))
           ORDER BY due_time ASC NULLS LAST, created_at ASC
           LIMIT 40`,
          [userId, localDate]
        ),
        pool.query(
          `SELECT id, title, start_time, end_time, source, gcal_event_id
           FROM time_blocks
           WHERE user_id = $1 AND block_date = $2::date
           ORDER BY start_time ASC`,
          [userId, localDate]
        ),
        pool.query(
          `SELECT fs.id, fs.task_id, fs.started_at, fs.planned_duration_seconds, t.title AS task_title
           FROM focus_sessions fs
           LEFT JOIN tasks t ON t.id = fs.task_id
           WHERE fs.user_id = $1 AND fs.ended_at IS NULL
           ORDER BY fs.started_at DESC LIMIT 1`,
          [userId]
        ),
        TimeEstimationService.getCalibration(pool, userId).catch(() => null),
      ]);

      const ratio = clampRatio(calibration?.avg_ratio);
      const hasCalibration = !!(calibration && calibration.total_tasks >= 3 && calibration.avg_ratio);

      // Per-task calibrated duration: explicit estimate first, then a history
      // suggestion for similar tasks, then a 30-min default — all scaled by
      // the user's personal estimate-vs-actual ratio. This is the
      // time-blindness prosthetic: blocks render at HONEST size.
      const tasks = [];
      for (const t of tasksResult.rows) {
        let baseMinutes = t.duration_minutes || null;
        let baseSource = baseMinutes ? 'estimate' : null;
        if (!baseMinutes) {
          try {
            const suggested = await TimeEstimationService.suggestEstimate(pool, userId, t.title);
            if (suggested) { baseMinutes = suggested; baseSource = 'history'; }
          } catch { /* suggestion is a bonus, never a blocker */ }
        }
        if (!baseMinutes) { baseMinutes = 30; baseSource = 'default'; }
        tasks.push({
          id: t.id,
          title: t.title,
          due_time: t.due_time ? String(t.due_time).slice(0, 5) : null,
          base_minutes: baseMinutes,
          calibrated_minutes: Math.round(baseMinutes * (hasCalibration ? ratio : 1)),
          base_source: baseSource,
        });
      }

      res.json({
        success: true,
        date: localDate,
        timezone: tz,
        tasks,
        blocks: blocksResult.rows.map(b => ({
          id: b.id,
          title: b.title,
          start_time: String(b.start_time).slice(0, 5),
          end_time: String(b.end_time).slice(0, 5),
          source: b.source || (b.gcal_event_id ? 'gcal' : 'manual'),
        })),
        active_focus: focusResult.rows[0] ? {
          task_id: focusResult.rows[0].task_id,
          task_title: focusResult.rows[0].task_title,
          started_at: focusResult.rows[0].started_at,
          planned_duration_seconds: focusResult.rows[0].planned_duration_seconds,
        } : null,
        calibration: hasCalibration ? {
          avg_ratio: Math.round(ratio * 100) / 100,
          total_tasks: calibration.total_tasks,
        } : null,
      });
    } catch (err) {
      console.error('[today] timeline failed:', err.message, '| userId:', req.user?.id);
      res.status(500).json({ success: false, message: 'Failed to load today' });
    }
  });

  return router;
};
