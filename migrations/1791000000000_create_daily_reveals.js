'use strict';
/**
 * Daily Reveal — one staged discovery per user per day.
 *
 * The reveal is the app's "give before ask": something new about the user,
 * hidden behind the open (curiosity gap → variable reward). The nightly job
 * stages it; the home page renders it sealed; the morning push teases its
 * headline. One row per user per local date.
 */
module.exports = {
  name: 'create_daily_reveals',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_reveals (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reveal_date  DATE NOT NULL,
        headline     TEXT NOT NULL,
        body         TEXT NOT NULL,
        science_tag  VARCHAR(60),
        reveal_type  VARCHAR(30) NOT NULL DEFAULT 'insight',
        viewed_at    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, reveal_date)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daily_reveals_user_date
        ON daily_reveals (user_id, reveal_date DESC)
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS daily_reveals`);
  },
};
