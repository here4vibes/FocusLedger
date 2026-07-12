'use strict';
/**
 * one_off_email_log — idempotency ledger for one-time email campaigns
 * (e.g. the beta/Autopilot re-engagement blast). UNIQUE(user_id, campaign)
 * makes re-running a blast job a no-op for anyone already emailed.
 */
module.exports = {
  name: 'create_one_off_email_log',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS one_off_email_log (
        id        SERIAL PRIMARY KEY,
        user_id   INTEGER NOT NULL,
        campaign  VARCHAR(80) NOT NULL,
        email     VARCHAR(255),
        sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, campaign)
      )
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS one_off_email_log`);
  },
};
