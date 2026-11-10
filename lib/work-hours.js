'use strict';
/**
 * lib/work-hours.js — "hours of work" framing for money in notifications.
 *
 * Owns: turning an amount + the user's hourly rate (users.hourly_rate, set in
 * Settings) into a short phrase, and the spending-review push wording.
 * Does NOT own: reading the rate or the review queue (callers pass them in).
 *
 * Display only: amounts arrive already computed (NUMERIC in SQL); the
 * division here never feeds storage or aggregation.
 */

/**
 * "about 45 min of work" / "about 2.5 hours of work", or null when there's no
 * rate (or nothing to convert) so callers can simply leave it out.
 * @param {number|string} amountDollars
 * @param {number|string|null} hourlyRate
 * @returns {string|null}
 */
function workHoursPhrase(amountDollars, hourlyRate) {
  const amount = Number(amountDollars);
  const rate = Number(hourlyRate);
  if (!(amount > 0) || !(rate > 0)) return null;

  const minutes = (amount / rate) * 60;
  if (minutes < 1) return 'under a minute of work';
  if (minutes < 59.5) {
    const m = minutes < 10 ? Math.round(minutes) : Math.round(minutes / 5) * 5;
    return `about ${m} min of work`;
  }
  const hours = Math.round((amount / rate) * 10) / 10;
  const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `about ${shown} ${hours === 1 ? 'hour' : 'hours'} of work`;
}

function formatDollars(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Body of the evening "charges to review" push.
 * @param {{ count: number, totalCents: number, hourlyRate?: number|string|null }} p
 * @returns {string} e.g. "3 charges to review ($84.20 · about 2.1 hours of work). Tap to check in."
 */
function reviewPushBody({ count, totalCents, hourlyRate }) {
  const what = `${count} ${count === 1 ? 'charge' : 'charges'} to review`;
  const hours = workHoursPhrase(totalCents / 100, hourlyRate);
  const detail = hours ? `${formatDollars(totalCents)} · ${hours}` : formatDollars(totalCents);
  return `${what} (${detail}). Tap to check in.`;
}

module.exports = { workHoursPhrase, reviewPushBody, formatDollars };
