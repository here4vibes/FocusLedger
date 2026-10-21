'use strict';
/**
 * lib/recurrence.js — next-occurrence math for recurring tasks and schedules,
 * built on rrule.js (RFC 5545 rules; BSD-3-Clause, see THIRD_PARTY_NOTICES.md).
 *
 * WHY: the hand-rolled math in routes/tasks-prisma.js and routes/recurring.js
 * overflowed month ends (a monthly task on the 31st jumped from Jan 31 to
 * Mar 3) and read weekdays in the server's clock zone.
 *
 * Dates are calendar dates (Postgres DATE, "YYYY-MM-DD"), not instants. They
 * are run through rrule as floating dates pinned to UTC midnight, so DST can
 * never shift a day. The user's timezone only decides what "today" is, so a
 * repeat finished late doesn't spawn an occurrence that is already overdue.
 *
 * Stored data is unchanged:
 *   tasks.recurrence_type   'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
 *                           plus 'biweekly' and 'monthly_last_weekday' (new
 *                           values, same text column: VARCHAR(20) / TEXT)
 *   tasks.recurrence_day    weekly/biweekly: 0=Sun..6=Sat; monthly: 1–31
 *                           (TEXT in prod, INT from scratch, so parse it)
 *   recurring_tasks/recurring_expenses.frequency
 *                           'daily' | 'weekly' | 'biweekly' | 'monthly' |
 *                           'quarterly' | 'yearly'
 */
const { RRule } = require('rrule');
const { getLocalDateParts } = require('./timezone');

const TASK_RECURRENCE_TYPES = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'monthly_last_weekday'];

const RECURRENCE_LABELS = {
  none: 'one-time',
  daily: 'every day',
  weekdays: 'every weekday',
  weekly: 'every week',
  biweekly: 'every other week',
  monthly: 'every month',
  monthly_last_weekday: 'on the last weekday of each month',
};

// JS getUTCDay() order (0 = Sunday) → rrule weekday constants.
const RRULE_DAYS = [RRule.SU, RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA];
const WEEKDAYS = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR];
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** True when recurrence_day means something for this type. */
function takesRecurrenceDay(type) {
  return type === 'weekly' || type === 'biweekly' || type === 'monthly';
}

/**
 * Normalize a DATE value to "YYYY-MM-DD", or null.
 * Strings: server.js makes pg return DATE as raw "YYYY-MM-DD"; a longer ISO
 * string keeps its date part. Date objects: node-pg's default DATE parser
 * builds local midnight, so read the local calendar fields.
 */
function toYmd(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const m = YMD_RE.exec(String(value));
  if (!m) return null;
  const d = ymdToUtc(m[0]);
  // Rejects impossible dates such as 2026-02-31 (Date.UTC would roll them over).
  return d && utcToYmd(d) === m[0] ? m[0] : null;
}

function ymdToUtc(ymd) {
  const m = YMD_RE.exec(ymd);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function utcToYmd(date) {
  return date.toISOString().slice(0, 10);
}

/** recurrence_day as an integer within [min, max], else null (it's TEXT in prod). */
function parseDay(raw, min, max) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * "Day N of the month", clamped to the month's last day: the 31st is Feb 28/29,
 * Apr 30 and so on. Plain BYMONTHDAY=31 would skip short months (RFC 5545), so
 * take the last of days 28..N that exists.
 */
function monthDayOptions(dom, interval = 1) {
  if (dom <= 28) return { freq: RRule.MONTHLY, interval, bymonthday: [dom] };
  const days = [];
  for (let d = 28; d <= dom; d++) days.push(d);
  return { freq: RRule.MONTHLY, interval, bymonthday: days, bysetpos: [-1] };
}

/**
 * The recurrence_day a task series is pinned to. Monthly and weekly tasks
 * created without one take it from their due date; storing it on the spawned
 * task stops drift (Jan 31 → Feb 28 must go on to Mar 31, not Mar 28).
 */
function resolveRecurrenceDay(type, rawDay, fromYmd) {
  const anchor = fromYmd ? ymdToUtc(fromYmd) : null;
  if (type === 'weekly' || type === 'biweekly') {
    const d = parseDay(rawDay, 0, 6);
    return d != null ? d : (anchor ? anchor.getUTCDay() : null);
  }
  if (type === 'monthly') {
    const d = parseDay(rawDay, 1, 31);
    return d != null ? d : (anchor ? anchor.getUTCDate() : null);
  }
  return null;
}

function taskRuleOptions(type, day) {
  switch (type) {
    case 'daily': return { freq: RRule.DAILY };
    case 'weekdays': return { freq: RRule.WEEKLY, byweekday: WEEKDAYS };
    case 'weekly': return { freq: RRule.WEEKLY, byweekday: [RRULE_DAYS[day]] };
    case 'biweekly': return { freq: RRule.WEEKLY, interval: 2, byweekday: [RRULE_DAYS[day]] };
    case 'monthly': return monthDayOptions(day);
    case 'monthly_last_weekday': return { freq: RRule.MONTHLY, byweekday: WEEKDAYS, bysetpos: [-1] };
    default: return null;
  }
}

/**
 * Next due date for a recurring task (tasks.recurrence_type / recurrence_day).
 *
 * @param {object} p
 * @param {string} p.type         recurrence_type
 * @param {*}      [p.day]        recurrence_day (string or number)
 * @param {*}      p.from         the completed task's due_date
 * @param {string} [p.tz]         user's IANA zone; when given, the result is
 *                                never before the user's local today
 * @param {Date}   [p.now]        clock override for tests
 * @returns {{ due_date: string, recurrence_day: number|null } | null}
 *          null when the task doesn't repeat or has no valid due date.
 */
function nextTaskOccurrence({ type, day, from, tz, now = new Date() }) {
  if (!TASK_RECURRENCE_TYPES.includes(type) || type === 'none') return null;
  const fromYmd = toYmd(from);
  if (!fromYmd) return null;

  const recurrenceDay = resolveRecurrenceDay(type, day, fromYmd);
  const options = taskRuleOptions(type, recurrenceDay);
  if (!options) return null;

  const dtstart = ymdToUtc(fromYmd);
  // dtstart anchors the cadence: every other week counts from the due date.
  const rule = new RRule({ ...options, dtstart });
  let next = rule.after(dtstart, false);

  if (next && tz) {
    const today = getLocalDateParts(tz, now).date;
    if (utcToYmd(next) < today) next = rule.after(ymdToUtc(today), true);
  }
  if (!next) return null;
  return { due_date: utcToYmd(next), recurrence_day: recurrenceDay };
}

const SCHEDULE_FREQUENCIES = {
  daily: { kind: 'days', interval: 1 },
  weekly: { kind: 'weeks', interval: 1 },
  biweekly: { kind: 'weeks', interval: 2 },
  monthly: { kind: 'months', interval: 1 },
  quarterly: { kind: 'months', interval: 3 },
  yearly: { kind: 'months', interval: 12 },
};

/**
 * Next date for a recurring_tasks / recurring_expenses template.
 * Month-based frequencies keep the day of month of the series' start_date,
 * clamped to short months, so Jan 31 → Feb 28 → Mar 31 (the old setMonth
 * math gave Jan 31 → Mar 3). Unknown frequencies fall back to weekly, as before.
 *
 * @param {*} fromDate   the current next_due_date (or first date)
 * @param {string} frequency
 * @param {*} [startDate] the series' start_date
 * @returns {string|null} "YYYY-MM-DD", or null when fromDate isn't a date
 */
function nextScheduleDate(fromDate, frequency, startDate) {
  const fromYmd = toYmd(fromDate);
  if (!fromYmd) return null;
  const spec = SCHEDULE_FREQUENCIES[frequency] || SCHEDULE_FREQUENCIES.weekly;
  const dtstart = ymdToUtc(fromYmd);

  let options;
  if (spec.kind === 'days') {
    options = { freq: RRule.DAILY, interval: spec.interval };
  } else if (spec.kind === 'weeks') {
    options = { freq: RRule.WEEKLY, interval: spec.interval, byweekday: [RRULE_DAYS[dtstart.getUTCDay()]] };
  } else {
    // Use the start date's day of month only while fromDate is consistent with
    // it (a clamped occurrence of that day); otherwise trust fromDate.
    const fromDom = dtstart.getUTCDate();
    const startYmd = toYmd(startDate);
    const startDom = startYmd ? ymdToUtc(startYmd).getUTCDate() : fromDom;
    const daysInMonth = new Date(Date.UTC(dtstart.getUTCFullYear(), dtstart.getUTCMonth() + 1, 0)).getUTCDate();
    const dom = Math.min(startDom, daysInMonth) === fromDom ? startDom : fromDom;
    options = monthDayOptions(dom, spec.interval);
  }

  const next = new RRule({ ...options, dtstart }).after(dtstart, false);
  return next ? utcToYmd(next) : null;
}

module.exports = {
  TASK_RECURRENCE_TYPES,
  RECURRENCE_LABELS,
  takesRecurrenceDay,
  toYmd,
  nextTaskOccurrence,
  nextScheduleDate,
};
