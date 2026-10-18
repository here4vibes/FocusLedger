'use strict';
// Owns: the free plan's active-task cap count (what counts toward the 10).
// Does NOT own: Pro status (middleware/proUtils.js), task creation (routes/tasks-prisma.js),
//               routines and their task links (db/routineNudges.js).

/** Free users may hold this many open tasks of their own. */
const FREE_TASK_LIMIT = 10;

/**
 * Open tasks that count toward the free cap: every open task except those
 * linked to one of the user's active routines (the starter routine's tasks
 * and any task the user added to a routine). Routine tasks reopen daily, so
 * counting them would quietly eat the free slots.
 *
 * Accepts a pool or a transaction client.
 * @returns {Promise<number>}
 */
async function countCappedOpenTasks(db, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS c
     FROM tasks t
     WHERE t.user_id = $1
       AND t.is_completed = false
       AND NOT EXISTS (
         SELECT 1 FROM routine_task_links l
         JOIN routines r ON r.id = l.routine_id
         WHERE l.task_id = t.id AND r.user_id = $1 AND r.is_active = true
       )`,
    [userId]
  );
  return rows[0].c;
}

/** True when a free user has no free task slot left. */
async function isAtFreeTaskCap(db, userId) {
  return (await countCappedOpenTasks(db, userId)) >= FREE_TASK_LIMIT;
}

module.exports = { FREE_TASK_LIMIT, countCappedOpenTasks, isAtFreeTaskCap };
