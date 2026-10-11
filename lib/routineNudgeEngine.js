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

const { getLocalDateParts } = require('./timezone');

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Gentle, no-pressure copy; avoids "Morning routine routine". */
function routineNudgeMessage(name) {
  const n = String(name || '').trim() || 'your routine';
  return /routine$/i.test(n) ? `"${n}" is ready when you are.` : `Your "${n}" routine is ready when you are.`;
}

/**
 * Insert today's nudge event for each routine that is due now and not done:
 * active, past its nudge_after_hour (user-local), scheduled for today if
 * weekly, not completed today, and the user hasn't turned routine nudges off.
 * (The query used to check only that nudge_after_hour was set, so an evening
 * routine nudged at 7am and weekly routines nudged every day.)
 * Returns array of generated nudge records.
 */
async function checkAndGenerateNudges(pool, userId, localDate, tz, now = new Date()) {
  const { hour, weekday } = getLocalDateParts(tz || 'America/New_York', now);
  const dow = WEEKDAYS.indexOf(String(weekday).toLowerCase());
  const { rows: routines } = await pool.query(
    `SELECT r.id, r.name
     FROM routines r
     WHERE r.user_id = $1
       AND r.nudge_after_hour IS NOT NULL
       AND r.nudge_after_hour <= $2
       AND COALESCE(r.is_active, true) = true
       AND (NULLIF(TRIM(r.day_of_week), '') IS NULL
            OR TRIM(r.day_of_week) = $3
            OR LEFT(LOWER(TRIM(r.day_of_week)), 3) = $4)
       AND NOT EXISTS (
         SELECT 1 FROM routine_streaks rs
         WHERE rs.routine_id = r.id AND rs.last_completed_date >= $5::date)
       AND NOT EXISTS (
         SELECT 1 FROM routine_nudge_prefs p
         WHERE p.user_id = r.user_id AND p.nudges_enabled = false)`,
    [userId, hour, String(dow), WEEKDAYS[dow] || '', localDate]
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
        [userId, routine.id, localDate, routineNudgeMessage(routine.name)]
      );
      nudges.push(inserted[0]);
    } catch (e) {
      console.warn('[routineNudgeEngine] nudge event insert failed | userId:', userId, '| routineId:', routine.id, '|', e.message);
    }
  }
  return nudges;
}

/**
 * Return pending routine nudges for the current session.
 */
async function getSessionNudges(pool, userId, localDate, _localTime) {
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

module.exports = { checkAndGenerateNudges, getSessionNudges, getLocalTimeString, routineNudgeMessage };
