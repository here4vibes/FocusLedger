'use strict';
/**
 * Source attribution for Daily Reveals. Every reveal whose body makes an
 * external claim (fun facts, interest facts) carries a real citation —
 * label + URL — rendered under the card. Personal-stat reveals (the user's
 * own data) don't need one.
 */
module.exports = {
  name: 'add_source_to_daily_reveals',

  up: async (client) => {
    await client.query(`
      ALTER TABLE daily_reveals
        ADD COLUMN IF NOT EXISTS source_label VARCHAR(160),
        ADD COLUMN IF NOT EXISTS source_url   TEXT
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE daily_reveals
        DROP COLUMN IF EXISTS source_label,
        DROP COLUMN IF EXISTS source_url
    `);
  },
};
