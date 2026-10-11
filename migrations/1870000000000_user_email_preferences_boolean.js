'use strict';
/**
 * user_email_preferences.weekly_nudge / re_engagement: TEXT -> BOOLEAN.
 *
 * The genesis schema created them as TEXT, but every reader and writer
 * treats them as booleans:
 *  - emailCron's re-engagement query (`uep.re_engagement = false`) failed on
 *    every run with "operator does not exist: text = boolean" (Sentry
 *    NODE-EXPRESS-5), so no re-engagement email has gone out since May.
 *  - the weekly nudge's `!prefs.weekly_nudge` read the string 'false',
 *    which is truthy in JS, so an opt-out was ignored.
 * NULL keeps meaning "no preference" (defaults to on). Idempotent: only
 * converts columns that are still text.
 */
const COLUMNS = ['weekly_nudge', 're_engagement'];

module.exports = {
  name: 'user_email_preferences_boolean',

  up: async (client) => {
    for (const col of COLUMNS) {
      const { rows } = await client.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'user_email_preferences' AND column_name = $1`,
        [col]
      );
      if (!rows[0] || rows[0].data_type === 'boolean') continue;
      await client.query(`
        ALTER TABLE user_email_preferences
        ALTER COLUMN ${col} TYPE BOOLEAN
        USING CASE
          WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN NULL
          ELSE LOWER(TRIM(${col})) IN ('true', 't', '1', 'yes', 'on')
        END`);
    }
  },

  down: async (client) => {
    for (const col of COLUMNS) {
      await client.query(`ALTER TABLE user_email_preferences ALTER COLUMN ${col} TYPE TEXT USING ${col}::text`);
    }
  },
};
