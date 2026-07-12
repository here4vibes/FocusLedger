'use strict';
/**
 * email_suppression — the unsubscribe list.
 *
 * Campaign/blast footers promise "Reply 'no more' and we'll never email you
 * again." This table is the mechanism that makes the promise true (and keeps
 * us CAN-SPAM compliant): the inbound-email webhook auto-adds repliers whose
 * message matches an opt-out phrase, and every marketing send path excludes
 * suppressed addresses. Keyed by email (not user_id) so it also covers leads
 * and survives account deletion/re-signup.
 */
module.exports = {
  name: 'create_email_suppression',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_suppression (
        id         SERIAL PRIMARY KEY,
        email      VARCHAR(255) NOT NULL,
        reason     VARCHAR(60) NOT NULL DEFAULT 'reply_opt_out',
        detail     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_suppression_email_unique
        ON email_suppression (LOWER(email))
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS email_suppression`);
  },
};
