// Owns: task_substeps table — AI-generated micro-step breakdowns for "I'm stuck" flow.
// Does NOT own: tasks table, task_steps table, or any buddy check-in data.

const { queryWithRetry } = require('../lib/queryWithRetry');

/**
 * Replace all substeps for a task with a fresh AI-generated set.
 * Called after POST /api/buddy/break-down succeeds.
 */
async function saveSubsteps(pool, userId, taskId, steps) {
  // Atomically clear old substeps and insert fresh ones
  await queryWithRetry(pool, 'DELETE FROM task_substeps WHERE task_id = $1 AND user_id = $2', [taskId, userId]);
  for (let i = 0; i < steps.length; i++) {
    await queryWithRetry(pool,
      `INSERT INTO task_substeps (task_id, user_id, step_text, step_order)
       VALUES ($1, $2, $3, $4)`,
      [taskId, userId, steps[i].text, i + 1]
    );
  }
}

/**
 * Fetch all substeps for a task, ordered by step_order.
 */
async function getSubsteps(pool, userId, taskId) {
  const result = await queryWithRetry(pool,
    `SELECT id, step_text, step_order, completed, completed_at
     FROM task_substeps
     WHERE task_id = $1 AND user_id = $2
     ORDER BY step_order ASC`,
    [taskId, userId]
  );
  return result.rows;
}

/**
 * Mark a single substep complete (or incomplete).
 * Returns the updated substep row.
 */
async function toggleSubstep(pool, userId, substepId, completed) {
  const result = await queryWithRetry(pool,
    `UPDATE task_substeps
     SET completed = $1, completed_at = $2
     WHERE id = $3 AND user_id = $4
     RETURNING id, task_id, step_text, step_order, completed, completed_at`,
    [completed, completed ? new Date() : null, substepId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Check if all substeps for a task are complete.
 * Returns { allDone, total, completedCount }
 */
async function checkAllDone(pool, userId, taskId) {
  const result = await queryWithRetry(pool,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS completed_count
     FROM task_substeps
     WHERE task_id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  const row = result.rows[0];
  const total = parseInt(row.total, 10);
  const completedCount = parseInt(row.completed_count, 10);
  return { allDone: total > 0 && completedCount === total, total, completedCount };
}

module.exports = { saveSubsteps, getSubsteps, toggleSubstep, checkAllDone };
