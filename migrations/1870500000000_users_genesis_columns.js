'use strict';
/**
 * users: add the genesis columns a from-scratch database never got.
 *
 * migrate.js's runCoreMigrations creates a minimal `users` table BEFORE the
 * folder migrations run, so genesis's `CREATE TABLE IF NOT EXISTS users (...)`
 * is a no-op and 20 columns were missing on any database built from scratch
 * (CI, local, a disaster-recovery rebuild). Buddy's first conversation then
 * failed with `column "session_count" does not exist`. Production already has
 * them, so there this only sets defaults.
 *
 * Counters: session_count had no default, so every new signup got NULL, and
 * `session_count + 1` stays NULL forever: 5 production accounts were stuck
 * looking like a first session on every visit. Both counters now default to 0
 * and NULLs become 0.
 */
const COLUMNS = [
  'is_admin BOOLEAN',
  'values_setup_skipped_count INTEGER',
  'email_autosuggest_enabled BOOLEAN',
  'values_banner_dismissed_at TIMESTAMPTZ',
  'city TEXT',
  'state_region TEXT',
  'zip_code TEXT',
  'country TEXT',
  'notif_morning_enabled BOOLEAN',
  'notif_evening_enabled BOOLEAN',
  'notif_morning_hour INTEGER',
  'notif_evening_hour INTEGER',
  'login_checkin_done_date DATE',
  'login_last_mood TEXT',
  'session_count INTEGER',
  'first_session_insights_done BOOLEAN',
  'tandem_trial_started_at TIMESTAMPTZ',
  'buddy_hook_restart_count INTEGER',
  'buddy_bubble_visible BOOLEAN',
  'buddy_bubble_position JSON',
];

module.exports = {
  name: 'users_genesis_columns',

  up: async (client) => {
    for (const def of COLUMNS) {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${def}`);
    }
    for (const col of ['session_count', 'buddy_hook_restart_count']) {
      await client.query(`ALTER TABLE users ALTER COLUMN ${col} SET DEFAULT 0`);
      const { rowCount } = await client.query(`UPDATE users SET ${col} = 0 WHERE ${col} IS NULL`);
      if (rowCount) console.log(`[migrate] users_genesis_columns: ${col} NULL -> 0 for ${rowCount} users`);
    }
  },

  down: async (client) => {
    // Columns are kept (they hold data); only the counter defaults are reverted.
    for (const col of ['session_count', 'buddy_hook_restart_count']) {
      await client.query(`ALTER TABLE users ALTER COLUMN ${col} DROP DEFAULT`);
    }
  },
};
