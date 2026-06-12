'use strict';
/**
 * routes/insights.js — Progressive Insights API under /api/v1/insights.
 *
 * Owns: GET /stats, GET /unlocks, POST /viewed.
 * Does NOT own: visual card UI (P2), cron job (P2), focus_sessions table (future).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  get_weekly_stats,
  get_insight_unlock_status,
  check_and_unlock_insights,
} = require('../services/InsightsService');
const { markViewed, markInteracted } = require('../db/insights');

module.exports = function InsightsRouter(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ── GET /api/v1/insights/stats ──────────────────────────────────────────────
  // Returns current-week stats (computed live) + recent weekly history.
  router.get('/stats', async (req, res) => {
    try {
      const userId = req.user.id;
      const { from, to } = req.query;

      // If explicit date bounds provided, still compute live for current week
      const result = await get_weekly_stats(pool, userId, { from, to });

      res.json({
        success: true,
        ...result,
      });
    } catch (err) {
      console.error('[insights] GET /stats error:', err);
      res.status(500).json({ success: false, message: 'Failed to load insights' });
    }
  });

  // ── GET /api/v1/insights/unlocks ────────────────────────────────────────────
  // Evaluates unlock conditions (fires check_and_unlock_insights), then returns
  // current unlock status for all insight tiers + current_value for progress bars.
  router.get('/unlocks', async (req, res) => {
    try {
      const userId = req.user.id;
      // Evaluate and upsert any newly-unlocked insights before returning status
      await check_and_unlock_insights(pool, userId);
      const status = await get_insight_unlock_status(pool, userId);

      // Compute current_value for each insight (used for progress bar fill on locked cards)
      const [txnResult, daysResult, taskResult, eveningResult] = await Promise.all([
        pool.query('SELECT COUNT(*) as cnt FROM transactions WHERE user_id = $1', [userId]),
        pool.query('SELECT COUNT(DISTINCT date) as days FROM transactions WHERE user_id = $1', [userId]),
        pool.query('SELECT COUNT(DISTINCT completed_at::date) as days FROM tasks WHERE user_id = $1 AND completed_at IS NOT NULL', [userId]),
        pool.query('SELECT COUNT(*) as cnt FROM buddy_checkins WHERE user_id = $1 AND checkin_type = $2', [userId, 'evening']),
      ]);

      const txnCount      = parseInt(txnResult.rows[0]?.cnt   || 0, 10);
      const distinctDays   = parseInt(daysResult.rows[0]?.days || 0, 10);
      const distinctTasks  = parseInt(taskResult.rows[0]?.days || 0, 10);
      const eveningCount   = parseInt(eveningResult.rows[0]?.cnt || 0, 10);

      // Attach current_value to each insight in the response
      const enrichedStatus = {};
      for (const [key, val] of Object.entries(status)) {
        enrichedStatus[key] = { ...val };
      }

      if (enrichedStatus.spending_this_week)
        enrichedStatus.spending_this_week.current_value = txnCount > 0 ? 1 : 0;
      if (enrichedStatus.spending_trend)
        enrichedStatus.spending_trend.current_value = distinctDays;
      if (enrichedStatus.task_completion_rate)
        enrichedStatus.task_completion_rate.current_value = distinctTasks;
      if (enrichedStatus.evening_session_streak)
        enrichedStatus.evening_session_streak.current_value = eveningCount;
      if (enrichedStatus.focus_pattern)
        enrichedStatus.focus_pattern.current_value = 0; // focus_sessions not yet available

      res.json({ success: true, unlocks: enrichedStatus });
    } catch (err) {
      console.error('[insights] GET /unlocks error:', err);
      res.status(500).json({ success: false, message: 'Failed to load unlock status' });
    }
  });

  // ── POST /api/v1/insights/viewed ────────────────────────────────────────────
  // Mark an insight as viewed by the user.
  router.post('/viewed', async (req, res) => {
    try {
      const userId = req.user.id;
      const { insight_key } = req.body;

      const VALID_KEYS = [
        'spending_this_week',
        'spending_trend',
        'task_completion_rate',
        'evening_session_streak',
        'focus_pattern',
      ];

      if (!insight_key || !VALID_KEYS.includes(insight_key)) {
        return res.status(400).json({
          success: false,
          message: `insight_key must be one of: ${VALID_KEYS.join(', ')}`,
        });
      }

      await markViewed(pool, userId, insight_key);
      res.json({ success: true });
    } catch (err) {
      console.error('[insights] POST /viewed error:', err);
      res.status(500).json({ success: false, message: 'Failed to mark as viewed' });
    }
  });

  // ── POST /api/v1/insights/interacted ─────────────────────────────────────────
  // Mark an insight as interacted with (card expanded/tapped).
  router.post('/interacted', async (req, res) => {
    try {
      const userId = req.user.id;
      const { insight_key } = req.body;

      const VALID_KEYS = [
        'spending_this_week',
        'spending_trend',
        'task_completion_rate',
        'evening_session_streak',
        'focus_pattern',
      ];

      if (!insight_key || !VALID_KEYS.includes(insight_key)) {
        return res.status(400).json({
          success: false,
          message: `insight_key must be one of: ${VALID_KEYS.join(', ')}`,
        });
      }

      await markInteracted(pool, userId, insight_key);
      res.json({ success: true });
    } catch (err) {
      console.error('[insights] POST /interacted error:', err);
      res.status(500).json({ success: false, message: 'Failed to mark as interacted' });
    }
  });

  return router;
};