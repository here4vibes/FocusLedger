// Owns: routines, routine_task_links, routine_streaks, routine_nudge_events,
//       routine_nudge_prefs tables.
// Does NOT own: tasks table, buddy check-ins, push notification delivery, or user auth.

'use strict';

// ── Routines ─────────────────────────────────────────────────────────────────

/**
 * Create a new routine for a user.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ name: string, routine_type: string, nudge_after_hour?: number, day_of_week?: number }} data
 */
async function createRoutine(pool, userId, data) {
  const { name, routine_type = 'am', nudge_after_hour, day_of_week } = data;
  // Default nudge_after_hour: 10 for AM, 20 for PM, 10 for weekly
  const defaultHour = routine_type === 'pm' ? 20 : 10;
  const hour = nudge_after_hour != null ? nudge_after_hour : defaultHour;

  const result = await pool.query(
    `INSERT INTO routines (user_id, name, routine_type, nudge_after_hour, day_of_week)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, name.trim(), routine_type, hour, day_of_week ?? null]
  );
  return result.rows[0];
}

/**
 * Get all active routines for a user, with their linked task IDs.
 */
async function getUserRoutines(pool, userId) {
  const routinesResult = await pool.query(
    `SELECT * FROM routines WHERE user_id = $1 AND is_active = true ORDER BY created_at ASC`,
    [userId]
  );
  if (!routinesResult.rows.length) return [];

  const routineIds = routinesResult.rows.map(r => r.id);
  const linksResult = await pool.query(
    `SELECT rtl.routine_id, rtl.task_id, t.title, t.is_completed
     FROM routine_task_links rtl
     JOIN tasks t ON t.id = rtl.task_id
     WHERE rtl.routine_id = ANY($1)`,
    [routineIds]
  );

  const tasksByRoutine = {};
  for (const link of linksResult.rows) {
    if (!tasksByRoutine[link.routine_id]) tasksByRoutine[link.routine_id] = [];
    tasksByRoutine[link.routine_id].push({
      task_id: link.task_id,
      title: link.title,
      is_completed: link.is_completed
    });
  }

  return routinesResult.rows.map(r => ({
    ...r,
    tasks: tasksByRoutine[r.id] || []
  }));
}

/**
 * Update a routine's name, type, or schedule.
 */
async function updateRoutine(pool, userId, routineId, data) {
  const sets = [];
  const params = [];
  let i = 1;

  if (data.name != null) { sets.push(`name = $${i++}`); params.push(data.name.trim()); }
  if (data.routine_type != null) { sets.push(`routine_type = $${i++}`); params.push(data.routine_type); }
  if (data.nudge_after_hour != null) { sets.push(`nudge_after_hour = $${i++}`); params.push(data.nudge_after_hour); }
  if (data.day_of_week !== undefined) { sets.push(`day_of_week = $${i++}`); params.push(data.day_of_week); }
  if (data.is_active != null) { sets.push(`is_active = $${i++}`); params.push(data.is_active); }

  if (!sets.length) return null;
  sets.push(`updated_at = NOW()`);
  params.push(routineId, userId);

  const result = await pool.query(
    `UPDATE routines SET ${sets.join(', ')}
     WHERE id = $${i++} AND user_id = $${i}
     RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

/**
 * Soft-delete (deactivate) a routine.
 */
async function deleteRoutine(pool, userId, routineId) {
  await pool.query(
    `UPDATE routines SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [routineId, userId]
  );
}

// ── Task Links ────────────────────────────────────────────────────────────────

/**
 * Add a task to a routine. Idempotent (ON CONFLICT DO NOTHING).
 */
async function addTaskToRoutine(pool, routineId, taskId) {
  await pool.query(
    `INSERT INTO routine_task_links (routine_id, task_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [routineId, taskId]
  );
}

/**
 * Remove a task from a routine.
 */
async function removeTaskFromRoutine(pool, routineId, taskId) {
  await pool.query(
    `DELETE FROM routine_task_links WHERE routine_id = $1 AND task_id = $2`,
    [routineId, taskId]
  );
}

// ── Streaks ───────────────────────────────────────────────────────────────────

/**
 * Get or create the streak record for a routine.
 */
async function getOrCreateStreak(pool, userId, routineId) {
  const existing = await pool.query(
    `SELECT * FROM routine_streaks WHERE routine_id = $1`,
    [routineId]
  );
  if (existing.rows.length) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO routine_streaks (user_id, routine_id)
     VALUES ($1, $2)
     ON CONFLICT (routine_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId, routineId]
  );
  return created.rows[0];
}

/**
 * Record that a routine was completed on a given local date.
 *
 * Streak math with forgiveness ("streak-freeze"):
 *   - same day (gap 0): no change — re-completing today doesn't inflate or reset
 *   - consecutive (gap 1): increment
 *   - one day missed (gap 2) AND a freeze is available: forgive — increment and
 *     spend the freeze so a single slip doesn't reset a hard-won streak
 *   - larger gap or no freeze: reset to 1 (a fresh start, with a fresh freeze)
 * A freeze replenishes every 7 consecutive completions.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {number} routineId
 * @param {string} localDate — YYYY-MM-DD in user's timezone
 * @returns {Promise<{current_streak:number,best_streak:number,freeze_used:boolean,freeze_available:boolean}>}
 */
async function recordRoutineCompletion(pool, userId, routineId, localDate) {
  const streak = await getOrCreateStreak(pool, userId, routineId);
  const last = streak.last_completed_date;
  // freeze_available may be undefined on rows created before the migration ran;
  // treat missing as "available" (the forgiving default).
  const freezeAvailable = streak.freeze_available !== false;

  let newStreak;
  let freezeUsed = false;
  let freezeLeft = freezeAvailable;

  if (last) {
    const lastDate = new Date(last + 'T12:00:00Z');
    const todayDate = new Date(localDate + 'T12:00:00Z');
    const diffDays = Math.round((todayDate - lastDate) / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) {
      // Same day (or clock skew) — don't double-count or reset.
      newStreak = Math.max(streak.current_streak, 1);
    } else if (diffDays === 1) {
      newStreak = streak.current_streak + 1;
    } else if (diffDays === 2 && freezeAvailable) {
      // Missed exactly one day — forgive it and spend the freeze.
      newStreak = streak.current_streak + 1;
      freezeUsed = true;
      freezeLeft = false;
    } else {
      // Streak broke — fresh start, with a fresh freeze in hand.
      newStreak = 1;
      freezeLeft = true;
    }
  } else {
    newStreak = 1;
  }

  // Replenish a freeze every 7 consecutive days (only when not just consumed).
  if (!freezeUsed && newStreak > 0 && newStreak % 7 === 0) {
    freezeLeft = true;
  }

  const newBest = Math.max(newStreak, streak.best_streak);
  const freezeUsedDate = freezeUsed ? localDate : (streak.last_freeze_used_date || null);

  await pool.query(
    `UPDATE routine_streaks
     SET current_streak = $1, best_streak = $2, last_completed_date = $3,
         freeze_available = $4, last_freeze_used_date = $5, updated_at = NOW()
     WHERE routine_id = $6`,
    [newStreak, newBest, localDate, freezeLeft, freezeUsedDate, routineId]
  );

  return {
    current_streak: newStreak,
    best_streak: newBest,
    freeze_used: freezeUsed,
    freeze_available: freezeLeft,
  };
}

/**
 * Get all streaks for a user's routines.
 */
async function getUserStreaks(pool, userId) {
  const result = await pool.query(
    `SELECT rs.*, r.name AS routine_name, r.routine_type
     FROM routine_streaks rs
     JOIN routines r ON r.id = rs.routine_id
     WHERE rs.user_id = $1 AND r.is_active = true
     ORDER BY rs.current_streak DESC`,
    [userId]
  );
  return result.rows;
}

// ── Nudge Events ──────────────────────────────────────────────────────────────

/**
 * Get or create a nudge event for a routine on a given date.
 * Used by the nudge engine to check/create daily nudges.
 */
async function getOrCreateNudgeEvent(pool, userId, routineId, nudgeDate) {
  const existing = await pool.query(
    `SELECT * FROM routine_nudge_events
     WHERE routine_id = $1 AND nudge_date = $2`,
    [routineId, nudgeDate]
  );
  if (existing.rows.length) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO routine_nudge_events (user_id, routine_id, nudge_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (routine_id, nudge_date) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [userId, routineId, nudgeDate]
  );
  return created.rows[0];
}

/**
 * Fetch all pending/shown nudges for a user on a given date.
 * Used at session start to surface pending nudge messages.
 */
async function getPendingNudges(pool, userId, nudgeDate) {
  const result = await pool.query(
    `SELECT rne.*, r.name AS routine_name, r.routine_type
     FROM routine_nudge_events rne
     JOIN routines r ON r.id = rne.routine_id
     WHERE rne.user_id = $1
       AND rne.nudge_date = $2
       AND rne.status IN ('pending', 'shown')
     ORDER BY rne.created_at ASC`,
    [userId, nudgeDate]
  );
  return result.rows;
}

/**
 * Update the status of a nudge event (on_it, skipped, snoozed).
 * Increments skip_count when status = 'skipped'.
 */
async function updateNudgeStatus(pool, userId, nudgeEventId, status) {
  const isSkip = status === 'skipped';
  const result = await pool.query(
    `UPDATE routine_nudge_events
     SET status = $1,
         skip_count = CASE WHEN $2 THEN skip_count + 1 ELSE skip_count END,
         updated_at = NOW()
     WHERE id = $3 AND user_id = $4
     RETURNING *`,
    [status, isSkip, nudgeEventId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Get the cumulative skip count for a routine across all dates.
 * Used to detect the "skipped 3+ times" escalation trigger.
 */
async function getRoutineSkipCount(pool, userId, routineId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(skip_count), 0)::int AS total_skips
     FROM routine_nudge_events
     WHERE user_id = $1 AND routine_id = $2`,
    [userId, routineId]
  );
  return result.rows[0]?.total_skips || 0;
}

// ── Nudge Preferences ─────────────────────────────────────────────────────────

/**
 * Get nudge preferences for a user. Returns defaults if not set.
 */
async function getNudgePrefs(pool, userId) {
  const result = await pool.query(
    `SELECT * FROM routine_nudge_prefs WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || { nudges_enabled: true, frequency: 'normal' };
}

/**
 * Upsert nudge preferences for a user.
 */
async function setNudgePrefs(pool, userId, prefs) {
  const { nudges_enabled, frequency } = prefs;
  const result = await pool.query(
    `INSERT INTO routine_nudge_prefs (user_id, nudges_enabled, frequency)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET nudges_enabled = EXCLUDED.nudges_enabled,
           frequency = EXCLUDED.frequency,
           updated_at = NOW()
     RETURNING *`,
    [userId, nudges_enabled ?? true, frequency ?? 'normal']
  );
  return result.rows[0];
}

/**
 * Check that a routine exists and belongs to the given user.
 * Returns the routine row, or null if not found.
 */
async function getRoutineForUser(pool, userId, routineId, activeOnly = false) {
  const activeClause = activeOnly ? 'AND is_active = true' : '';
  const result = await pool.query(
    `SELECT id, name, routine_type FROM routines WHERE id = $1 AND user_id = $2 ${activeClause}`,
    [routineId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Check that a task exists and belongs to the given user.
 * Returns the task id row, or null if not found.
 */
async function getTaskForUser(pool, userId, taskId) {
  const result = await pool.query(
    'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
    [taskId, userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  createRoutine,
  getUserRoutines,
  updateRoutine,
  deleteRoutine,
  getRoutineForUser,
  getTaskForUser,
  addTaskToRoutine,
  removeTaskFromRoutine,
  getOrCreateStreak,
  recordRoutineCompletion,
  getUserStreaks,
  getOrCreateNudgeEvent,
  getPendingNudges,
  updateNudgeStatus,
  getRoutineSkipCount,
  getNudgePrefs,
  setNudgePrefs,
};
