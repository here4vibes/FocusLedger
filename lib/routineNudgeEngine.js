'use strict';

/**
 * Returns a local time string "HH:MM" for the given timezone.
 */
function getLocalTimeString(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toTimeString().slice(0, 5);
  }
}

/**
 * Check routines with nudge_after_hour triggers and insert nudge events for
 * any that haven't fired yet today.
 * Returns array of generated nudge records.
 */
async function checkAndGenerateNudges(pool, userId, localDate, tz) {
  const { rows: routines } = await pool.query(
    `SELECT r.id, r.name, r.nudge_after_hour
     FROM routines r
     WHERE r.user_id = $1 AND r.nudge_after_hour IS NOT NULL`,
    [userId]
  );
  const nudges = [];
  for (const routine of routines) {
    // Check if nudge already sent today
    const { rows: existing } = await pool.query(
      `SELECT id FROM routine_nudge_events
       WHERE user_id = $1 AND routine_id = $2 AND nudge_date = $3
       LIMIT 1`,
      [userId, routine.id, localDate]
    );
    if (existing.length) continue;
    try {
      const { rows: inserted } = await pool.query(
        `INSERT INTO routine_nudge_events (user_id, routine_id, nudge_date, status, message)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING *`,
        [userId, routine.id, localDate, `Time to work on your "${routine.name}" routine!`]
      );
      nudges.push(inserted[0]);
    } catch {}
  }
  return nudges;
}

/**
 * Return pending routine nudges for the current session.
 */
async function getSessionNudges(pool, userId, localDate, localTime) {
  const { rows } = await pool.query(
    `SELECT rn.id, rn.message, rn.status, r.name AS routine_name, rn.created_at
     FROM routine_nudge_events rn
     JOIN routines r ON r.id = rn.routine_id
     WHERE rn.user_id = $1 AND rn.nudge_date = $2 AND rn.status = 'pending'
     ORDER BY rn.created_at DESC
     LIMIT 5`,
    [userId, localDate]
  );
  return rows;
}

module.exports = { checkAndGenerateNudges, getSessionNudges, getLocalTimeString };
