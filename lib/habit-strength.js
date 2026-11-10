'use strict';
/**
 * Habit strength: a forgiving 0–100 score for a routine.
 *
 * A streak answers "how many days in a row?", so one slip sends it back to 1.
 * Habit strength answers "how established is this habit?" instead. It is an
 * exponentially weighted average of the routine's history:
 *
 *   score = score × (1 − α) + α × (done this period ? 1 : 0)
 *   α     = 1 − 2^(−1 / halfLife)
 *
 * Each completed period pulls the score toward 100; each missed period lets it
 * decay gently. With a half-life of 14 days, one missed day after a long run
 * costs about 5 points, and the score halves only after two straight weeks
 * off. It builds up gradually too (about 77% after 30 days in a row, 95% after
 * 60), so it rewards consistency over time rather than one good week.
 *
 * Periods:
 *   - daily routines ('am', 'pm', anything not 'weekly') count per local day,
 *     half-life DAILY_HALF_LIFE_DAYS (14) days;
 *   - weekly routines count per 7-day block starting on the routine's first
 *     day, half-life WEEKLY_HALF_LIFE_WEEKS (4) weeks, so a single missed week
 *     costs about 16 points instead of wiping half the score.
 * The current period is still in progress: it counts only once completed, so
 * the score doesn't drop in the morning before the user has had a chance.
 *
 * All dates are YYYY-MM-DD in the user's local timezone. Pure: no DB, no clock
 * (callers pass `today`; see strengthForRoutine for the timezone wrapper).
 */
const { getLocalDateParts } = require('./timezone');

const DAILY_HALF_LIFE_DAYS = 14;
const WEEKLY_HALF_LIFE_WEEKS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Day number of a YYYY-MM-DD date (days since 1970-01-01). */
function dayIndex(date) {
  return Math.round(Date.parse(date + 'T00:00:00Z') / DAY_MS);
}

function toDateString(value) {
  // node-postgres parses a DATE column to local midnight, so read local parts.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  const s = String(value || '').slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

/**
 * @param {object}   opts
 * @param {string[]} opts.completions  local dates the routine was completed
 * @param {string}   opts.today        the user's local date today
 * @param {string}   [opts.startDate]  local date the routine started (default:
 *                                     its first completion)
 * @param {'daily'|'weekly'} [opts.cadence='daily']
 * @param {number}   [opts.halfLife]   in periods (days or weeks)
 * @returns {number} integer 0–100
 */
function habitStrength({ completions = [], today, startDate, cadence = 'daily', halfLife } = {}) {
  const todayStr = toDateString(today);
  if (!todayStr) return 0;
  const todayIdx = dayIndex(todayStr);
  const doneDays = new Set();
  for (const c of completions) {
    const s = toDateString(c);
    if (s) {
      const i = dayIndex(s);
      if (i <= todayIdx) doneDays.add(i);
    }
  }
  if (!doneDays.size) return 0;

  const firstDone = Math.min(...doneDays);
  const startStr = toDateString(startDate);
  let startIdx = startStr ? Math.min(dayIndex(startStr), firstDone) : firstDone;
  if (startIdx > todayIdx) startIdx = todayIdx;

  const weekly = cadence === 'weekly';
  const len = weekly ? 7 : 1;
  const hl = Number(halfLife) > 0 ? Number(halfLife) : (weekly ? WEEKLY_HALF_LIFE_WEEKS : DAILY_HALF_LIFE_DAYS);
  const alpha = 1 - Math.pow(2, -1 / hl);

  const donePeriods = new Set([...doneDays].map(i => Math.floor((i - startIdx) / len)));
  const current = Math.floor((todayIdx - startIdx) / len);
  // The current period counts only once it's done; otherwise stop before it.
  const last = donePeriods.has(current) ? current : current - 1;

  let score = 0;
  for (let p = 0; p <= last; p++) {
    score = score * (1 - alpha) + (donePeriods.has(p) ? alpha : 0);
  }
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

/**
 * Timezone wrapper: score a routine row as of `now` in the user's timezone.
 * @param {object} opts
 * @param {string[]} opts.completions local dates (routine_completions.local_date)
 * @param {Date|string|null} [opts.createdAt] routines.created_at (an instant)
 * @param {string} [opts.routineType] 'am' | 'pm' | 'weekly'
 * @param {string} opts.tz validated IANA timezone
 * @param {Date} [opts.now]
 */
function strengthForRoutine({ completions, createdAt, routineType, tz, now = new Date() }) {
  const today = getLocalDateParts(tz, now).date;
  let startDate;
  if (createdAt) {
    const d = createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (!Number.isNaN(d.getTime())) startDate = getLocalDateParts(tz, d).date;
  }
  return habitStrength({
    completions,
    today,
    startDate,
    cadence: routineType === 'weekly' ? 'weekly' : 'daily',
  });
}

module.exports = {
  habitStrength,
  strengthForRoutine,
  DAILY_HALF_LIFE_DAYS,
  WEEKLY_HALF_LIFE_WEEKS,
};
