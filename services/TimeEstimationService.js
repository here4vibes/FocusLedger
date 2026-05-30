'use strict';
/**
 * services/TimeEstimationService.js — Time-Blindness calibration logic.
 *
 * Owns: calibration scoring, suggestion generation from past actuals.
 * Does NOT own: database queries (see db/time-estimations.js), API routing, or UI.
 */

const timeEstDb = require('../db/time-estimations');

/**
 * Record a user's time estimate for a task.
 * Upserts — re-estimating before completion updates the estimate.
 */
async function recordEstimation(pool, userId, taskId, estimatedMinutes) {
  return timeEstDb.upsertEstimation(pool, { userId, taskId, estimatedMinutes });
}

/**
 * Record actual completion time and compute calibration_score.
 * calibration_score = actual / estimated. 1.0 = perfect.
 * < 1 means task was faster than expected, > 1 means slower.
 */
async function recordCompletion(pool, taskId, userId, actualMinutes) {
  return timeEstDb.recordCompletion(pool, { taskId, userId, actualMinutes });
}

/**
 * Get full calibration stats for a user.
 * Returns: { avg_ratio, total_tasks, accurate_count, underestimated_count, overestimated_count }
 */
async function getCalibration(pool, userId) {
  const stats = await timeEstDb.getCalibrationStats(pool, userId);
  return {
    avg_ratio: stats.avg_ratio ? parseFloat(stats.avg_ratio) : null,
    total_tasks: stats.total_tasks || 0,
    accurate_count: stats.accurate_count || 0,
    underestimated_count: stats.underestimated_count || 0,
    overestimated_count: stats.overestimated_count || 0,
  };
}

/**
 * Suggest a time estimate based on similar past tasks.
 * Extracts significant words from title (>3 chars, no stop words),
 * finds past actuals for matching tasks, returns median.
 */
async function suggestEstimate(pool, userId, taskTitle) {
  if (!taskTitle || taskTitle.trim().length < 3) return null;

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'will',
    'been', 'were', 'they', 'them', 'what', 'when', 'where', 'which',
    'about', 'into', 'your', 'more', 'some', 'than', 'other', 'also',
  ]);

  const words = taskTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));

  if (words.length === 0) return null;

  const actuals = await timeEstDb.findSimilarTaskActuals(pool, userId, words);
  if (actuals.length === 0) return null;

  // Median of actual times
  const sorted = actuals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  return {
    suggested_minutes: median,
    based_on_count: actuals.length,
  };
}

module.exports = {
  recordEstimation,
  recordCompletion,
  getCalibration,
  suggestEstimate,
};
