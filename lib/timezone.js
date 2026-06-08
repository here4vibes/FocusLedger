'use strict';
/**
 * lib/timezone.js — Timezone-aware date helpers.
 * WHY: Neon runs UTC; user-facing dates must use each user's local timezone
 * so morning nudges fire at 8 AM *local*, not 8 AM UTC.
 */

/**
 * Return { date, hour, minute } in the given IANA timezone.
 * @param {string} tz   — IANA zone, e.g. 'America/New_York'
 * @param {Date}   now  — optional, defaults to new Date()
 * @returns {{ date: string, hour: number, minute: number }}
 */
function getLocalDateParts(tz, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  return { date, hour, minute };
}

/**
 * Return the current local date string (YYYY-MM-DD) for a user's timezone.
 * @param {string} tz
 * @returns {string}
 */
function getUserLocalDate(tz) {
  return getLocalDateParts(tz).date;
}

/**
 * Look up a user's IANA timezone from the DB.
 * Accepts either a pg.Pool or a PrismaClient.
 * Falls back to 'America/New_York' if the column is null or the query fails.
 */
async function fetchUserTimezone(db, userId) {
  try {
    let rows;
    if (db && typeof db.$queryRawUnsafe === 'function') {
      rows = await db.$queryRawUnsafe(
        'SELECT timezone FROM users WHERE id = $1', userId
      );
    } else if (db && typeof db.query === 'function') {
      const result = await db.query(
        'SELECT timezone FROM users WHERE id = $1', [userId]
      );
      rows = result.rows;
    } else {
      return 'America/New_York';
    }
    return (rows && rows[0] && rows[0].timezone) || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

module.exports = { getLocalDateParts, getUserLocalDate, fetchUserTimezone };
