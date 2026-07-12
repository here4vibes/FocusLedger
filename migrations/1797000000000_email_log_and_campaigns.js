'use strict';
/**
 * email_log — audit trail every sendEmail() writes to (referenced by code for
 * years — e.g. the v2-launch dedup queries it — but never created by any
 * migration). email_campaigns — drafts + send state for the self-service
 * admin campaign tool.
 */
module.exports = {
  name: 'email_log_and_campaigns',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_log (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER,
        template_type VARCHAR(60),
        to_email      VARCHAR(255),
        subject       TEXT,
        resend_id     VARCHAR(100),
        success       BOOLEAN NOT NULL DEFAULT true,
        error         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_log_user_template_idx
        ON email_log (user_id, template_type)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_campaigns (
        id              SERIAL PRIMARY KEY,
        subject         TEXT NOT NULL,
        body            TEXT NOT NULL,
        audience        VARCHAR(30) NOT NULL DEFAULT 'all',
        status          VARCHAR(20) NOT NULL DEFAULT 'draft',
        recipient_count INTEGER,
        sent_count      INTEGER NOT NULL DEFAULT 0,
        failed_count    INTEGER NOT NULL DEFAULT 0,
        created_by      INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at         TIMESTAMPTZ
      )
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS email_campaigns`);
    // email_log intentionally kept — audit data
  },
};
