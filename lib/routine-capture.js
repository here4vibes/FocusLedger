'use strict';
/**
 * Routine capture without a second step.
 *
 * Before: ticking a routine's tasks recorded nothing; the streak only moved if
 * the user also pressed "Complete routine" on the Routines page, and the
 * routine's tasks stayed ticked forever, so the routine never came back the
 * next day. Now:
 *   - finishing the last open task of a routine completes the routine (streak),
 *     wherever the tick happened: Tasks, Home radar, Buddy, the agent;
 *   - routine tasks reopen each day (weekly routines each week) whenever the
 *     task lists load, so there's no cron to configure.
 */
const {
  recordRoutineCompletion,
  reopenStaleRoutineTasks,
  getRoutinesFinishedByTasks,
} = require('../db/routineNudges');
const { fetchUserTimezone, validateTimezone, getUserLocalDate } = require('./timezone');

async function userClock(pool, userId) {
  const tz = validateTimezone(await fetchUserTimezone(pool, userId)) || 'America/New_York';
  return { tz, localDate: getUserLocalDate(tz) };
}

/**
 * Call after any task(s) were marked done. Records a completion for each
 * routine the tick finished.
 * @param {number|number[]} taskIds
 * @returns {Promise<{routine_id:number, name:string, current_streak:number, best_streak:number}[]>}
 */
async function onTasksCompleted(pool, userId, taskIds) {
  const ids = (Array.isArray(taskIds) ? taskIds : [taskIds])
    .map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  const { tz, localDate } = await userClock(pool, userId);
  const finished = await getRoutinesFinishedByTasks(pool, userId, ids, tz, localDate);
  const out = [];
  for (const r of finished) {
    const streak = await recordRoutineCompletion(pool, userId, r.id, localDate);
    console.log('[routine-capture] routine completed by its tasks | userId:', userId, '| routineId:', r.id, '| streak:', streak.current_streak);
    out.push({ routine_id: r.id, name: r.name, current_streak: streak.current_streak, best_streak: streak.best_streak });
  }
  return out;
}

/** Reopen routine tasks finished on an earlier day. Returns how many reopened. */
async function refreshRoutineTasks(pool, userId) {
  const { tz, localDate } = await userClock(pool, userId);
  return reopenStaleRoutineTasks(pool, userId, tz, localDate);
}

module.exports = { onTasksCompleted, refreshRoutineTasks };
