#!/usr/bin/env node
/**
 * jobs/patternDetectionJob.js — Weekly pattern detection across all users.
 *
 * Scans the last 8 weeks of completed tasks per user, identifies recurring
 * title patterns, scores them for day-of-week consistency, and writes results
 * to detected_patterns + routine_suggestions.
 *
 * Runs Sunday nights so suggestions are fresh for the week. Safe to re-run —
 * upsertDetectedPattern uses ON CONFLICT DO NOTHING and createRoutineSuggestion
 * dedupes on (user_id, pattern_id, status='pending').
 */
'use strict';

const { Pool } = require('pg');
const {
  upsertDetectedPattern,
  createRoutineSuggestion,
  expireIgnoredSuggestions,
} = require('../db/patternDetection');

const LOOKBACK_DAYS = 56;       // 8 weeks
const MIN_OCCURRENCES = 3;      // at least 3 completions to qualify
const MIN_CONFIDENCE_DETECT = 0.35;   // write to detected_patterns
const MIN_CONFIDENCE_SUGGEST = 0.50;  // also create a routine_suggestion
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|a|an|my|our|your|to|at|for|in|on)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dayConsistencyScore(dayCounts, total) {
  if (!total) return 0;
  const max = Math.max(...Object.values(dayCounts));
  return max / total;
}

function dominantDays(dayCounts) {
  const sorted = Object.entries(dayCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([, count]) => count >= 2)
    .map(([day]) => parseInt(day));
  return sorted;
}

async function detectPatternsForUser(pool, userId) {
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  const sinceStr = since.toISOString().slice(0, 10);

  const result = await pool.query(
    `SELECT id, title, completed_at::date AS completed_date,
            EXTRACT(DOW FROM completed_at) AS dow
     FROM tasks
     WHERE user_id = $1
       AND is_completed = true
       AND completed_at IS NOT NULL
       AND completed_at::date >= $2
     ORDER BY completed_at ASC`,
    [userId, sinceStr]
  );

  const rows = result.rows;
  if (rows.length < MIN_OCCURRENCES) return;

  // Count which weeks had any task activity (for frequency denominator)
  const activeWeeks = new Set(rows.map(r => {
    const d = new Date(r.completed_date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    return weekStart.toISOString().slice(0, 10);
  }));
  const totalOpportunities = Math.max(activeWeeks.size, 1);

  // Group by normalized title
  const groups = {};
  for (const row of rows) {
    const key = normalizeTitle(row.title);
    if (!key || key.length < 3) continue;
    if (!groups[key]) groups[key] = { rows: [], titles: new Set() };
    groups[key].rows.push(row);
    groups[key].titles.add(row.title);
  }

  // Expire ignored suggestions before adding new ones
  await expireIgnoredSuggestions(pool, userId);

  for (const [normalizedKey, group] of Object.entries(groups)) {
    const occurrenceCount = group.rows.length;
    if (occurrenceCount < MIN_OCCURRENCES) continue;

    // Day-of-week distribution
    const dayCounts = {};
    for (const row of group.rows) {
      const dow = parseInt(row.dow);
      dayCounts[dow] = (dayCounts[dow] || 0) + 1;
    }

    const consistencyScore = dayConsistencyScore(dayCounts, occurrenceCount);
    const frequencyScore = Math.min(occurrenceCount / totalOpportunities, 1);
    const confidenceScore = parseFloat((frequencyScore * consistencyScore).toFixed(3));

    if (confidenceScore < MIN_CONFIDENCE_DETECT) continue;

    const domDays = dominantDays(dayCounts);
    const taskIds = group.rows.map(r => r.id).slice(-5); // keep most recent 5

    const patternData = {
      normalized_title: normalizedKey,
      task_titles: Array.from(group.titles).slice(0, 3),
      task_ids: taskIds,
      dominant_days: domDays,
      day_labels: domDays.map(d => DAY_NAMES[d]),
      weekly_frequency: parseFloat((occurrenceCount / (LOOKBACK_DAYS / 7)).toFixed(2)),
      day_counts: dayCounts,
    };

    const pattern = await upsertDetectedPattern(pool, userId, {
      patternType: domDays.length > 0 ? 'day' : 'frequency',
      patternData,
      occurrenceCount,
      totalOpportunities,
      timeConsistencyScore: parseFloat(consistencyScore.toFixed(3)),
      confidenceScore,
    });

    if (pattern && confidenceScore >= MIN_CONFIDENCE_SUGGEST) {
      await createRoutineSuggestion(pool, userId, pattern.id).catch(() => null);
    }
  }
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });

  try {
    const usersResult = await pool.query(
      `SELECT DISTINCT user_id FROM tasks
       WHERE is_completed = true
         AND completed_at IS NOT NULL
         AND completed_at >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'`
    );

    const userIds = usersResult.rows.map(r => r.user_id);
    console.log(`[pattern-detection] Running for ${userIds.length} users`);

    let succeeded = 0;
    for (const userId of userIds) {
      try {
        await detectPatternsForUser(pool, userId);
        succeeded++;
      } catch (err) {
        console.error(`[pattern-detection] Error for user ${userId}:`, err.message);
      }
    }

    console.log(`[pattern-detection] Done. ${succeeded}/${userIds.length} users processed`);
  } catch (err) {
    console.error('[pattern-detection] Fatal error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
