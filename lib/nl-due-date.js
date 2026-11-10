'use strict';
/**
 * lib/nl-due-date.js — natural-language due dates for typed task capture.
 *
 * "dentist Tuesday 3pm"   → { title: 'dentist',  due_date: <next Tue>, due_time: '15:00' }
 * "pay rent on the 1st"   → { title: 'pay rent', due_date: <next 1st>, due_time: null }
 * "buy milk"              → unchanged, no date
 *
 * Parsing uses chrono-node (MIT, see THIRD_PARTY_NOTICES.md) against the
 * user's *local* wall clock, so "tomorrow" typed at 10pm in New York means the
 * New York tomorrow even when UTC has already rolled over.
 *
 * WHY a fake reference Date: chrono resolves weekdays and relative days with
 * the process's local Date methods, and its `timezone` option only takes an
 * abbreviation or a fixed offset. Building a reference Date whose *process-local*
 * fields equal the user's wall clock, then reading the result's fields back,
 * gives the same answer whatever TZ the server runs in.
 *
 * Pure: no DB, no network. Callers pass the user's IANA zone.
 */

const chrono = require('chrono-node');
const { getLocalDateParts } = require('./timezone');

// "on the 1st", "the 15th" — chrono's casual parser doesn't read a bare
// day-of-month. Only when the ordinal ends the phrase (end, punctuation, a time,
// "of the month"), so "order the 2nd monitor" stays a title.
const DAY_OF_MONTH_RE = /(?:\bon\s+)?\bthe\s+([1-9]|[12]\d|3[01])(?:st|nd|rd|th)(?:\s+of\s+the\s+month)?(?=\s*$|\s*[,.;!]|\s+(?:at|@|by)\b|\s+\d)/i;

function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

const dayOfMonthParser = {
  pattern: () => DAY_OF_MONTH_RE,
  extract: (context, match) => {
    const ref = context.refDate;
    const day = parseInt(match[1], 10);
    let year = ref.getFullYear();
    let month = ref.getMonth() + 1;
    if (day < ref.getDate()) {
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    return { year, month, day: Math.min(day, daysInMonth(year, month)) };
  },
};

const parser = chrono.casual.clone();
parser.parsers.push(dayOfMonthParser);

// Words chrono reads as dates that are usually not dates in a task title:
// "fix the sat nav", "email Sun Life", "do it now".
const REJECT_TEXT = /^(?:on\s+|at\s+)?(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat|now|right now)$/i;

// Connector words left dangling once the date phrase is cut out.
const TRAILING_CONNECTOR = /\s*\b(?:on|at|by|due|before|until|for|this)\s*$/i;

function pad(n) { return String(n).padStart(2, '0'); }

function ymd(year, month1, day) { return `${year}-${pad(month1)}-${pad(day)}`; }

function cleanTitle(text, index, length) {
  const before = text.slice(0, index).replace(TRAILING_CONNECTOR, '');
  const after = text.slice(index + length);
  return `${before} ${after}`
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
}

/**
 * Pull a due date/time out of a typed task title.
 * @param {string} text  raw title as typed
 * @param {string} tz    user's IANA zone (users.timezone)
 * @param {Date}  [now]  injectable clock for tests
 * @returns {{ title: string, due_date: string|null, due_time: string|null, matched: string|null }}
 */
function parseDueDate(text, tz, now = new Date()) {
  const unchanged = { title: text, due_date: null, due_time: null, matched: null };
  if (typeof text !== 'string' || !text.trim()) return unchanged;

  const local = getLocalDateParts(tz || 'America/New_York', now);
  const [ly, lm, ld] = local.date.split('-').map(Number);
  const ref = new Date(ly, lm - 1, ld, local.hour, local.minute, 0, 0);

  const results = parser.parse(text, ref, { forwardDate: true });
  const r = results.find(x => !REJECT_TEXT.test(x.text.trim()));
  if (!r) return unchanged;

  const s = r.start;
  // A bare month ("March for science", "Dr. May at 9") is too vague to be a due date.
  if (s.isCertain('month') && !s.isCertain('day')) return unchanged;

  let year = s.get('year');
  let month = s.get('month');
  let day = s.get('day');
  let dueTime = null;

  if (s.isCertain('hour')) {
    let hour = s.get('hour');
    const minute = s.get('minute') || 0;
    // "at 3" / "at 5:30" with no am/pm: people mean the afternoon for 1–7.
    if (!s.isCertain('meridiem') && hour >= 1 && hour <= 7) hour += 12;
    dueTime = `${pad(hour)}:${pad(minute)}`;

    // Time only ("take meds at 8"): the next time that clock time comes round.
    const dayStated = s.isCertain('day') || s.isCertain('weekday');
    if (!dayStated) {
      const later = hour * 60 + minute > local.hour * 60 + local.minute;
      const d = new Date(ly, lm - 1, ld + (later ? 0 : 1));
      year = d.getFullYear(); month = d.getMonth() + 1; day = d.getDate();
    }
  }

  const title = cleanTitle(text, r.index, r.text.length) || text.trim();
  return { title, due_date: ymd(year, month, day), due_time: dueTime, matched: r.text };
}

module.exports = { parseDueDate };
