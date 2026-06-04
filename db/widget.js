'use strict';

/**
 * Return today's tasks for the iOS widget — incomplete tasks due today or overdue.
 */
async function getTodayWidgetTasks(pool, userId, localToday, tz) {
  const { rows } = await pool.query(
    `SELECT id, title, is_completed, due_date, due_time, priority, value_id
     FROM tasks
     WHERE user_id = $1
       AND is_completed = false
       AND (due_date IS NULL OR due_date <= $2::date)
     ORDER BY
       CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END,
       due_date ASC NULLS LAST,
       created_at ASC
     LIMIT 10`,
    [userId, localToday]
  );
  return rows;
}

module.exports = { getTodayWidgetTasks };
