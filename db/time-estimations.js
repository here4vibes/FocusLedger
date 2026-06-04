'use strict';
/**
 * db/time-estimations.js — Named query functions for task_time_estimations table.
 *
 * Owns: task_time_estimations (user time estimates + actuals + calibration scores)
 * Does NOT own: tasks, users, or any AI suggestion logic (see services/TimeEstimationService.js)
 */

const { queryWithRetry } = require('../lib/queryWithRetry');

/**
 * Upsert a time estimation for a task. One estimation per task (UNIQUE constraint).
 * If re-estimated before completion, updates the estimate in place.
 */
async function upsertEstimation(pool, { userId, taskId, estimatedMinutes }) {
  const result = await queryWithRetry(pool, `
    INSERT INTO task_time_estimations (user_id, task_id, estimated_minutes)
    VALUES ($1, $2, $3)
    ON CONFLICT (task_id) DO UPDATE SET
      estimated_minutes = EXCLUDED.estimated_minutes,
      estimated_at = now()
    RETURNING id, user_id, task_id, estimated_minutes, actual_minutes, calibration_score, estimated_at
  `, [userId, taskId, estimatedMinutes]);
  return result.rows[0];
}

/**
 * Record actual completion time and compute calibration score.
 */
async function recordCompletion(pool, { taskId, userId, actualMinutes }) {
  const result = await queryWithRetry(pool, `
    UPDATE task_time_estimations
    SET actual_minutes = $1,
        completed_at = now(),
        calibration_score = ROUND(($1::float / NULLIF(estimated_minutes, 0)), 2)
    WHERE task_id = $2 AND user_id = $3
    RETURNING id, estimated_minutes, actual_minutes, calibration_score
  `, [actualMinutes, taskId, userId]);
  return result.rows[0] || null;
}

/**
 * Get estimation for a specific task (ownership scoped).
 */
async function getEstimationByTaskId(pool, { taskId, userId }) {
  const result = await queryWithRetry(pool, `
    SELECT id, task_id, estimated_minutes, actual_minutes, calibration_score, estimated_at, completed_at
    FROM task_time_estimations
    WHERE task_id = $1 AND user_id = $2
  `, [taskId, userId]);
  return result.rows[0] || null;
}

/**
 * Get the last N estimations with task titles for history display.
 */
async function getHistory(pool, userId, limit = 20) {
  const result = await queryWithRetry(pool, `
    SELECT tte.id, tte.task_id, tte.estimated_minutes, tte.actual_minutes,
           tte.calibration_score, tte.estimated_at, tte.completed_at,
           t.title as task_title, t.is_completed as task_completed
    FROM task_time_estimations tte
    JOIN tasks t ON t.id = tte.task_id
    WHERE tte.user_id = $1
    ORDER BY tte.estimated_at DESC
    LIMIT $2
  `, [userId, limit]);
  return result.rows;
}

/**
 * Get calibration stats: avg ratio, counts of accurate/under/over.
 * Only considers completed estimations (both estimate and actual present).
 */
async function getCalibrationStats(pool, userId) {
  const result = await queryWithRetry(pool, `
    SELECT
      COUNT(*)::int as total_tasks,
      ROUND(AVG(calibration_score)::numeric, 2) as avg_ratio,
      COUNT(*) FILTER (WHERE calibration_score BETWEEN 0.8 AND 1.2)::int as accurate_count,
      COUNT(*) FILTER (WHERE calibration_score < 0.8)::int as underestimated_count,
      COUNT(*) FILTER (WHERE calibration_score > 1.2)::int as overestimated_count
    FROM task_time_estimations
    WHERE user_id = $1
      AND actual_minutes IS NOT NULL
      AND calibration_score IS NOT NULL
  `, [userId]);
  return result.rows[0];
}

/**
 * Find similar past tasks by title word overlap for suggestion.
 * Returns median actual_minutes from completed tasks with matching words.
 */
async function findSimilarTaskActuals(pool, userId, titleWords) {
  // WHY: simple word-match approach avoids AI call overhead for suggestions.
  // We look for tasks where any word in the title matches any word in the input.
  // This is good enough for "Buy groceries" matching past "Buy groceries" tasks.
  const result = await queryWithRetry(pool, `
    SELECT tte.actual_minutes
    FROM task_time_estimations tte
    JOIN tasks t ON t.id = tte.task_id
    WHERE tte.user_id = $1
      AND tte.actual_minutes IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM unnest($2::text[]) AS word
        WHERE t.title ILIKE '%' || word || '%'
      )
    ORDER BY tte.completed_at DESC
    LIMIT 10
  `, [userId, titleWords]);
  return result.rows.map(r => r.actual_minutes);
}

module.exports = {
  upsertEstimation,
  recordCompletion,
  getEstimationByTaskId,
  getHistory,
  getCalibrationStats,
  findSimilarTaskActuals,
};
