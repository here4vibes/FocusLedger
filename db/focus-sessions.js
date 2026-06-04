'use strict';

async function createSession(pool, { userId, taskId, plannedDurationSeconds }) {
  const { rows } = await pool.query(
    `INSERT INTO focus_sessions (user_id, task_id, planned_duration_seconds, started_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id`,
    [userId, taskId || null, plannedDurationSeconds || null]
  );
  return rows[0];
}

async function completeSession(pool, { sessionId, userId, actualDurationSeconds, completed }) {
  const { rows } = await pool.query(
    `UPDATE focus_sessions
     SET actual_duration_seconds = $3,
         completed = $4,
         ended_at  = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [sessionId, userId, actualDurationSeconds, completed]
  );
  return rows[0] || null;
}

async function getRecentSessions(pool, userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT fs.id, fs.task_id, fs.planned_duration_seconds, fs.actual_duration_seconds,
            fs.completed, fs.started_at, fs.ended_at, t.title AS task_title
     FROM focus_sessions fs
     LEFT JOIN tasks t ON t.id = fs.task_id
     WHERE fs.user_id = $1
     ORDER BY fs.started_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

module.exports = { createSession, completeSession, getRecentSessions };
