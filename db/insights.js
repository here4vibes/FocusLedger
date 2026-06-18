'use strict';
/**
 * db/insights.js — Named query functions for weekly_stats + insight_unlocks tables.
 *
 * Owns: weekly_stats, insight_unlocks
 * Does NOT own: tasks, transactions, spending_sessions (see respective db/ files).
 */

const { queryWithRetry } = require('../lib/queryWithRetry');

// ── weekly_stats ──────────────────────────────────────────────────────────────

/**
 * Upsert a weekly_stats row for a user + week_start.
 * Called by the daily cron (P2). Safe to re-run — UNIQUE constraint handles upsert.
 */
async function upsertWeeklyStats(pool, params) {
  const {
    userId,
    weekStart,
    tasksCompleted = 0,
    tasksCreated = 0,
    totalFocusMinutes = 0,
    totalSpendCents = 0,
    impulseCount = 0,
    plannedCount = 0,
    eveningSessionsCompleted = 0,
    routinesCompleted = 0,
    streakDays = 0,
  } = params;

  return queryWithRetry(pool, `
    INSERT INTO weekly_stats
      (user_id, week_start, tasks_completed, tasks_created, total_focus_minutes,
       total_spend_cents, impulse_count, planned_count, evening_sessions_completed,
       routines_completed, streak_days, computed_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    ON CONFLICT (user_id, week_start) DO UPDATE SET
      tasks_completed       = EXCLUDED.tasks_completed,
      tasks_created         = EXCLUDED.tasks_created,
      total_focus_minutes   = EXCLUDED.total_focus_minutes,
      total_spend_cents     = EXCLUDED.total_spend_cents,
      impulse_count         = EXCLUDED.impulse_count,
      planned_count         = EXCLUDED.planned_count,
      evening_sessions_completed = EXCLUDED.evening_sessions_completed,
      routines_completed    = EXCLUDED.routines_completed,
      streak_days           = EXCLUDED.streak_days,
      computed_at           = now()
    RETURNING *
  `, [userId, weekStart, tasksCompleted, tasksCreated, totalFocusMinutes,
      totalSpendCents, impulseCount, plannedCount, eveningSessionsCompleted,
      routinesCompleted, streakDays]);
}

/**
 * Get weekly stats for a user within a date range.
 */
async function getWeeklyStatsRange(pool, userId, fromDate, toDate) {
  return queryWithRetry(pool, `
    SELECT week_start, tasks_completed, tasks_created, total_focus_minutes,
           total_spend_cents, impulse_count, planned_count,
           evening_sessions_completed, routines_completed, streak_days, computed_at
    FROM weekly_stats
    WHERE user_id = $1 AND week_start >= $2 AND week_start <= $3
    ORDER BY week_start ASC
  `, [userId, fromDate, toDate]);
}

/**
 * Get the most recent weekly_stats row for a user (for current week live data fallback).
 */
async function getLatestWeeklyStats(pool, userId) {
  return queryWithRetry(pool, `
    SELECT * FROM weekly_stats
    WHERE user_id = $1
    ORDER BY week_start DESC
    LIMIT 1
  `, [userId]);
}

// ── insight_unlocks ────────────────────────────────────────────────────────────

/**
 * Upsert an insight unlock for a user. Called when condition is first met.
 * safe to re-run — UNIQUE constraint handles upsert.
 */
async function upsertUnlock(pool, userId, insightKey) {
  return queryWithRetry(pool, `
    INSERT INTO insight_unlocks (user_id, insight_key, unlocked_at)
    VALUES ($1, $2, now())
    ON CONFLICT (user_id, insight_key) DO NOTHING
    RETURNING *
  `, [userId, insightKey]);
}

/**
 * Mark an insight as viewed by the user.
 */
async function markViewed(pool, userId, insightKey) {
  return queryWithRetry(pool, `
    UPDATE insight_unlocks
    SET viewed = true
    WHERE user_id = $1 AND insight_key = $2
    RETURNING *
  `, [userId, insightKey]);
}

/**
 * Mark an insight as interacted with by the user.
 */
async function markInteracted(pool, userId, insightKey) {
  return queryWithRetry(pool, `
    UPDATE insight_unlocks
    SET interacted = true
    WHERE user_id = $1 AND insight_key = $2
    RETURNING *
  `, [userId, insightKey]);
}

/**
 * Get all insight unlock records for a user.
 */
async function getUserUnlocks(pool, userId) {
  return queryWithRetry(pool, `
    SELECT insight_key, unlocked_at, viewed, interacted
    FROM insight_unlocks
    WHERE user_id = $1
  `, [userId]);
}

/**
 * Check if a specific insight is unlocked for a user.
 */
async function isUnlocked(pool, userId, insightKey) {
  return queryWithRetry(pool, `
    SELECT 1 FROM insight_unlocks
    WHERE user_id = $1 AND insight_key = $2
    LIMIT 1
  `, [userId, insightKey]);
}

// ── cross_domain_insights ─────────────────────────────────────────────────────

/**
 * Save (or replace) the weekly AI-generated cross-domain insight for a user.
 * One row per user per week_start — UPSERT overwrites if the job re-runs.
 */
async function saveCrossDomainInsight(pool, userId, weekStart, insightText) {
  return queryWithRetry(pool, `
    INSERT INTO cross_domain_insights (user_id, week_start, insight_text, generated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (user_id, week_start) DO UPDATE SET
      insight_text = EXCLUDED.insight_text,
      generated_at = NOW()
    RETURNING *
  `, [userId, weekStart, insightText]);
}

/**
 * Return the most recent cross-domain insight generated in the last 7 days,
 * so it can be surfaced as a greeting insight in the Buddy session-status.
 */
async function getLatestCrossDomainInsight(pool, userId) {
  return queryWithRetry(pool, `
    SELECT insight_text, generated_at, week_start
    FROM cross_domain_insights
    WHERE user_id = $1 AND generated_at >= NOW() - INTERVAL '7 days'
    ORDER BY generated_at DESC
    LIMIT 1
  `, [userId]);
}

module.exports = {
  upsertWeeklyStats,
  getWeeklyStatsRange,
  getLatestWeeklyStats,
  upsertUnlock,
  markViewed,
  markInteracted,
  getUserUnlocks,
  isUnlocked,
  saveCrossDomainInsight,
  getLatestCrossDomainInsight,
};