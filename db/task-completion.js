'use strict';
// Owns: completing a single task outside the Tasks API (push-notification actions).
// Does NOT own: task creation/editing (routes/tasks-prisma.js), routines (db/routineNudges.js).

/**
 * Mark one of the user's tasks done. Idempotent.
 * @returns {Promise<{ found: boolean, changed: boolean, title: string|null }>}
 */
async function markTaskDone(pool, userId, taskId) {
  const upd = await pool.query(
    `UPDATE tasks SET is_completed = true, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_completed = false
     RETURNING title`,
    [taskId, userId]
  );
  if (upd.rows.length) return { found: true, changed: true, title: upd.rows[0].title };
  const cur = await pool.query('SELECT title FROM tasks WHERE id = $1 AND user_id = $2', [taskId, userId]);
  return { found: cur.rows.length > 0, changed: false, title: cur.rows[0] ? cur.rows[0].title : null };
}

module.exports = { markTaskDone };
