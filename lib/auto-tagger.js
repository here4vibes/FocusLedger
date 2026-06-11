'use strict';

async function _queryRows(db, sql, params) {
  const r = await db.query(sql, params);
  return r.rows;
}

/**
 * Match a task title to one of the user's values using keyword matching.
 * Returns a value ID or null.
 */
async function matchTaskToValue(pool, userId, title) {
  if (!title || !pool) return null;
  const rows = await _queryRows(
    pool,
    'SELECT id, value_name FROM user_values WHERE user_id = $1 ORDER BY id',
    [userId]
  );
  if (!rows.length) return null;
  const lower = title.toLowerCase();
  for (const v of rows) {
    if (lower.includes(v.value_name.toLowerCase())) return v.id;
  }
  return null;
}

/**
 * Backfill value tags for all untagged active tasks for a user.
 * Returns { tasksUpdated: number }.
 */
async function backfillUser(pool, userId) {
  const tasks = await _queryRows(
    pool,
    `SELECT id, title FROM tasks WHERE user_id = $1 AND value_id IS NULL AND is_completed = false`,
    [userId]
  );
  let updated = 0;
  for (const task of tasks) {
    const valueId = await matchTaskToValue(pool, userId, task.title);
    if (valueId) {
      await _queryRows(pool, 'UPDATE tasks SET value_id = $1 WHERE id = $2', [valueId, task.id]);
      updated++;
    }
  }
  return { tasksUpdated: updated };
}

module.exports = { matchTaskToValue, backfillUser };
