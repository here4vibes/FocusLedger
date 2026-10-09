'use strict';
/**
 * Archive tables for analytics rows produced by automated browsers.
 *
 * Our own CI smoke tests load the public pages on production with ordinary
 * device user agents, four browser profiles per run, so they slipped past the
 * server's UA bot filter: ~90% of recorded "visitors" in Oct 2026 (pricing
 * visitors per day were exactly 4x the day's smoke runs). The client now sends
 * nothing when navigator.webdriver is set; these tables hold the historical
 * rows, moved out (not deleted) so every existing report is accurate without
 * per-query filters, and the move stays reversible.
 */
module.exports = {
  name: 'analytics_automated_archive',

  up: async (client) => {
    for (const t of ['visitor_sessions', 'analytics_events']) {
      await client.query(`CREATE TABLE IF NOT EXISTS ${t}_automated (LIKE ${t} INCLUDING DEFAULTS)`);
      await client.query(`ALTER TABLE ${t}_automated ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NOW()`);
      await client.query(`ALTER TABLE ${t}_automated ADD COLUMN IF NOT EXISTS archive_reason TEXT`);
    }
  },

  down: async () => {
    // Archive tables are kept: dropping them would destroy the moved rows.
  },
};
