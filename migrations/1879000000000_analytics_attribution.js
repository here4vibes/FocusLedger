'use strict';
/**
 * Ad attribution + bot/CI filter counts.
 *
 * - users.first_touch JSONB: the sanitized first-touch attribution captured on
 *   the visitor's first landing (lib/attribution.js): utm_*, a truncated
 *   fbclid/gclid, referrer domain, landing page, first_seen. Written once at
 *   signup. users.utm_* and signup_referrer (now a bare domain) keep being set
 *   for existing reports; fbclid/gclid had no column.
 * - analytics_filtered_daily: per day × reason × kind ('visit'|'event') count
 *   of analytics requests dropped as bot/CI (lib/analytics-filter.js), so the
 *   admin can see real vs filtered without storing bot rows. No PII.
 * Idempotent.
 */
module.exports = {
  name: 'analytics_attribution',

  up: async (client) => {
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS first_touch JSONB');
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_filtered_daily (
        day    DATE    NOT NULL,
        reason TEXT    NOT NULL,
        kind   TEXT    NOT NULL,
        hits   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, reason, kind)
      )`);
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS analytics_filtered_daily');
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS first_touch');
  },
};
