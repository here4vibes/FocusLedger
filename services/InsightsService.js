'use strict';
/**
 * services/InsightsService.js — Progressive Insights computation layer.
 *
 * Owns: weekly stats computation, insight unlock evaluation, unlock status.
 * Does NOT own: focus_sessions table (deferred to Focus Mode P1).
 *
 * Data sources: tasks, transactions, spending_sessions, buddy_checkins,
 *               routines, routine_streaks, weekly_stats (all existing tables).
 */

const {
  upsertWeeklyStats,
  getWeeklyStatsRange,
  upsertUnlock,
  getUserUnlocks,
} = require('../db/insights');

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Get the Monday of the week containing a given date.
 */
function getWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // adjust to Monday
  const monday = new Date(d.setUTCDate(diff));
  return monday.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/**
 * Get today's date as YYYY-MM-DD UTC.
 */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get last N weeks of Monday dates (for history queries).
 */
function getLastNWeekStarts(n) {
  const starts = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i * 7);
    starts.push(getWeekStart(d.toISOString().slice(0, 10)));
  }
  return starts;
}

// ── Live data computation (current week) ──────────────────────────────────────

/**
 * Compute current-week stats by querying existing tables directly.
 * This runs in real-time for GET /api/v1/insights/stats — no cron required.
 */
async function computeLiveWeeklyStats(pool, userId) {
  const weekStart = getWeekStart(todayUTC());
  const weekEnd = todayUTC(); // current week up to today

  // Tasks completed this week (completed_at within the week)
  const tasksCompletedResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = $1
      AND completed_at::date >= $2
      AND completed_at::date <= $3
  `, [userId, weekStart, weekEnd]);

  // Tasks created this week
  const tasksCreatedResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM tasks
    WHERE user_id = $1
      AND created_at::date >= $2
      AND created_at::date <= $3
  `, [userId, weekStart, weekEnd]);

  // Spending: total_spend_cents, impulse_count, planned_count
  // Pulls from transactions + transaction_classifications linked via spending_sessions
  const spendingResult = await pool.query(`
    SELECT
      COALESCE(SUM(t.amount), 0)                                       AS total_spend_cents,
      COALESCE(SUM(CASE WHEN tc.classification = 'impulse' THEN 1 ELSE 0 END), 0) AS impulse_count,
      COALESCE(SUM(CASE WHEN tc.classification = 'planned' THEN 1 ELSE 0 END), 0) AS planned_count
    FROM transactions t
    LEFT JOIN spending_sessions ss ON ss.session_date = t.date AND ss.user_id = t.user_id
    LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id
    WHERE t.user_id = $1
      AND t.date >= $2
      AND t.date <= $3
  `, [userId, weekStart, weekEnd]);

  // Evening sessions completed this week (buddy_checkins type='evening' + complete=true)
  const eveningSessionsResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM buddy_checkins
    WHERE user_id = $1
      AND type = 'evening'
      AND completed = true
      AND checkin_date >= $2
      AND checkin_date <= $3
  `, [userId, weekStart, weekEnd]);

  // Routines completed this week (routine_streaks where last_completed_date >= weekStart)
  const routinesCompletedResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM routine_streaks
    WHERE user_id = $1
      AND last_completed_date >= $2
      AND last_completed_date <= $3
  `, [userId, weekStart, weekEnd]);

  const tasksCompleted = parseInt(tasksCompletedResult.rows[0]?.cnt || 0, 10);
  const tasksCreated   = parseInt(tasksCreatedResult.rows[0]?.cnt || 0, 10);
  const spending       = spendingResult.rows[0];
  const eveningSessions = parseInt(eveningSessionsResult.rows[0]?.cnt || 0, 10);
  const routinesCompleted = parseInt(routinesCompletedResult.rows[0]?.cnt || 0, 10);

  return {
    week_start: weekStart,
    tasks_completed: tasksCompleted,
    tasks_created: tasksCreated,
    total_focus_minutes: 0,  // P2 — requires focus_sessions table
    total_spend_cents: parseInt(spending.total_spend_cents || 0, 10),
    impulse_count: parseInt(spending.impulse_count || 0, 10),
    planned_count: parseInt(spending.planned_count || 0, 10),
    evening_sessions_completed: eveningSessions,
    routines_completed: routinesCompleted,
    streak_days: 0,  // P2 — computed from daily pattern
  };
}

// ── Main service methods ───────────────────────────────────────────────────────

/**
 * GET /api/v1/insights/stats — weekly data for current + past N weeks.
 *
 * @param {Pool} pool
 * @param {number} userId
 * @param {object} opts  — { from, to } optional date bounds
 * @returns {{ weekly: object, history: object[] }}
 */
async function get_weekly_stats(pool, userId, opts = {}) {
  const currentWeek = await computeLiveWeeklyStats(pool, userId);

  // Build history from past weekly_stats rows (populated by cron in P2)
  const last4Weeks = getLastNWeekStarts(4);
  const oldestWeek = last4Weeks[last4Weeks.length - 1];

  const historyRows = await getWeeklyStatsRange(pool, userId, oldestWeek, last4Weeks[0]);

  return {
    weekly: currentWeek,
    history: historyRows.rows,
  };
}

/**
 * Evaluate unlock conditions and upsert newly unlocked insights.
 * Returns the full unlock status map for the user.
 *
 * @param {Pool} pool
 * @param {number} userId
 * @returns {object}  { [insightKey]: { unlocked, viewed, interacted, days_left } }
 */
async function check_and_unlock_insights(pool, userId) {
  // Collect all data needed to evaluate conditions
  const weekStart = getWeekStart(todayUTC());

  // Condition 1: spending_this_week — ≥1 transaction
  const txnCountResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM transactions WHERE user_id = $1
  `, [userId]);
  const txnCount = parseInt(txnCountResult.rows[0]?.cnt || 0, 10);

  // Condition 2: spending_trend — ≥7 distinct days with transactions
  const distinctDaysResult = await pool.query(`
    SELECT COUNT(DISTINCT date) as days FROM transactions
    WHERE user_id = $1
  `, [userId]);
  const distinctTxDays = parseInt(distinctDaysResult.rows[0]?.days || 0, 10);

  // Condition 3: task_completion_rate — ≥3 days with completed tasks
  const taskDaysResult = await pool.query(`
    SELECT COUNT(DISTINCT completed_at::date) as days FROM tasks
    WHERE user_id = $1 AND completed_at IS NOT NULL
  `, [userId]);
  const distinctTaskDays = parseInt(taskDaysResult.rows[0]?.days || 0, 10);

  // Condition 4: evening_session_streak — ≥2 completed evening sessions
  const eveningCountResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM buddy_checkins
    WHERE user_id = $1 AND type = 'evening' AND completed = true
  `, [userId]);
  const eveningCount = parseInt(eveningCountResult.rows[0]?.cnt || 0, 10);

  // Insight unlock thresholds
  const INSIGHT_THRESHOLDS = {
    spending_this_week:      { min: 1,  dataKey: 'txnCount' },
    spending_trend:          { min: 7,  dataKey: 'distinctTxDays' },
    task_completion_rate:   { min: 3,  dataKey: 'distinctTaskDays' },
    evening_session_streak: { min: 2,  dataKey: 'eveningCount' },
    // focus_pattern: deferred — no focus_sessions table yet
  };

  // Evaluate and unlock
  const data = { txnCount, distinctTxDays, distinctTaskDays, eveningCount };
  for (const [insightKey, { min, dataKey }] of Object.entries(INSIGHT_THRESHOLDS)) {
    const value = data[dataKey];
    if (value >= min) {
      await upsertUnlock(pool, userId, insightKey);
    }
  }

  // Return full status map
  return get_insight_unlock_status(pool, userId);
}

/**
 * Get the current unlock status for all insight tiers.
 *
 * @param {Pool} pool
 * @param {number} userId
 * @returns {object}  { [insightKey]: { unlocked, viewed, interacted, days_left } }
 */
async function get_insight_unlock_status(pool, userId) {
  const rows = await getUserUnlocks(pool, userId);
  const unlockedMap = {};
  for (const row of rows.rows) {
    unlockedMap[row.insight_key] = {
      unlocked:  true,
      viewed:    row.viewed,
      interacted: row.interacted,
      days_left: null,
    };
  }

  // Compute days_left for NOT-yet-unlocked insights
  // We estimate based on minimum data requirements not yet met.
  const weekStart = getWeekStart(todayUTC());

  const txnCountResult = await pool.query(`SELECT COUNT(*) as cnt FROM transactions WHERE user_id = $1`, [userId]);
  const txnCount = parseInt(txnCountResult.rows[0]?.cnt || 0, 10);

  const distinctDaysResult = await pool.query(`SELECT COUNT(DISTINCT date) as days FROM transactions WHERE user_id = $1`, [userId]);
  const distinctTxDays = parseInt(distinctDaysResult.rows[0]?.days || 0, 10);

  const taskDaysResult = await pool.query(`SELECT COUNT(DISTINCT completed_at::date) as days FROM tasks WHERE user_id = $1 AND completed_at IS NOT NULL`, [userId]);
  const distinctTaskDays = parseInt(taskDaysResult.rows[0]?.days || 0, 10);

  const eveningCountResult = await pool.query(`SELECT COUNT(*) as cnt FROM buddy_checkins WHERE user_id = $1 AND type = 'evening' AND completed = true`, [userId]);
  const eveningCount = parseInt(eveningCountResult.rows[0]?.cnt || 0, 10);

  const TIER_CONFIG = {
    spending_this_week:      { threshold: 1,  current: txnCount },
    spending_trend:          { threshold: 7,  current: distinctTxDays },
    task_completion_rate:   { threshold: 3,  current: distinctTaskDays },
    evening_session_streak: { threshold: 2,  current: eveningCount },
    focus_pattern:           { threshold: 5,  current: 0, always_locked: true }, // No table yet
  };

  const result = {};
  for (const [insightKey, config] of Object.entries(TIER_CONFIG)) {
    if (unlockedMap[insightKey]) {
      result[insightKey] = unlockedMap[insightKey];
    } else {
      const remaining = config.threshold - config.current;
      result[insightKey] = {
        unlocked:  false,
        viewed:    false,
        interacted: false,
        days_left: config.always_locked ? null : Math.max(0, remaining),
      };
    }
  }

  return result;
}

module.exports = {
  get_weekly_stats,
  get_insight_unlock_status,
  check_and_unlock_insights,
  // Exported for testing / cron
  computeLiveWeeklyStats,
  getWeekStart,
};