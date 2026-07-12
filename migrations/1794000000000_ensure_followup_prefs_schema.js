'use strict';
/**
 * Ensure the follow-up email tables match what jobs/followupEmailCheck.js and
 * db/followupEmails.js actually query.
 *
 * The followup-email-check cron keeps failing after the u.plan fix; the
 * remaining schema suspect is user_followup_prefs existing in a Prisma-era
 * narrow shape (or not at all) while the code expects wide per-type columns:
 * task_reminder(_hour), routine_streak(_hour), weekly_summary(_hour),
 * follow_through(_hour). Everything here is idempotent; each step runs under
 * its own SAVEPOINT so one miss can't abort the rest.
 */

const steps = [
  {
    name: 'create user_followup_prefs',
    sql: [`CREATE TABLE IF NOT EXISTS user_followup_prefs (
             user_id             INTEGER NOT NULL,
             task_reminder       BOOLEAN NOT NULL DEFAULT true,
             task_reminder_hour  INTEGER NOT NULL DEFAULT 9,
             routine_streak      BOOLEAN NOT NULL DEFAULT true,
             routine_streak_hour INTEGER NOT NULL DEFAULT 9,
             weekly_summary      BOOLEAN NOT NULL DEFAULT true,
             weekly_summary_hour INTEGER NOT NULL DEFAULT 9,
             follow_through      BOOLEAN NOT NULL DEFAULT true,
             follow_through_hour INTEGER NOT NULL DEFAULT 9,
             created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
             updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`],
  },
  {
    name: 'widen user_followup_prefs (pre-existing narrow table)',
    sql: [`ALTER TABLE user_followup_prefs
             ADD COLUMN IF NOT EXISTS task_reminder       BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS task_reminder_hour  INTEGER NOT NULL DEFAULT 9,
             ADD COLUMN IF NOT EXISTS routine_streak      BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS routine_streak_hour INTEGER NOT NULL DEFAULT 9,
             ADD COLUMN IF NOT EXISTS weekly_summary      BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS weekly_summary_hour INTEGER NOT NULL DEFAULT 9,
             ADD COLUMN IF NOT EXISTS follow_through      BOOLEAN NOT NULL DEFAULT true,
             ADD COLUMN IF NOT EXISTS follow_through_hour INTEGER NOT NULL DEFAULT 9`],
  },
  {
    name: 'unique index for ON CONFLICT (user_id)',
    sql: [
      `DELETE FROM user_followup_prefs a USING user_followup_prefs b
        WHERE a.user_id = b.user_id AND a.ctid < b.ctid`,
      `CREATE UNIQUE INDEX IF NOT EXISTS user_followup_prefs_user_id_unique
         ON user_followup_prefs (user_id)`,
    ],
  },
  {
    name: 'create followup_email_log (send-history dedup)',
    sql: [
      // Columns match db/followupEmails.js exactly: alreadySentToday filters on
      // user_id/email_type/trigger_ref/sent_at::date; logSent inserts
      // trigger_label + subject too.
      `CREATE TABLE IF NOT EXISTS followup_email_log (
         id            SERIAL PRIMARY KEY,
         user_id       INTEGER NOT NULL,
         email_type    VARCHAR(50) NOT NULL,
         trigger_ref   VARCHAR(150),
         trigger_label VARCHAR(255),
         subject       TEXT,
         sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE INDEX IF NOT EXISTS followup_email_log_lookup
         ON followup_email_log (user_id, email_type, trigger_ref, sent_at)`,
    ],
  },
];

module.exports = {
  name: 'ensure_followup_prefs_schema',

  up: async (client) => {
    for (const step of steps) {
      await client.query('SAVEPOINT step_sp');
      try {
        for (const sql of step.sql) await client.query(sql);
        await client.query('RELEASE SAVEPOINT step_sp');
        console.log(`[migration] applied: ${step.name}`);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT step_sp');
        console.warn(`[migration] ${step.name} skipped: ${e.message}`);
      }
    }
  },
};
