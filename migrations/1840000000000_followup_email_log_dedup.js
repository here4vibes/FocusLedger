'use strict';
/**
 * Robust dedup for follow-up emails.
 *
 * The old followup_email_log had only a lookup index, and the job did
 * check-then-send-then-log with a fire-and-forget send. So when a log write
 * failed (e.g. during the Neon compute outage, when INSERTs errored), no dedup
 * row was recorded and the SAME email went out on every 15-minute cron run —
 * the "3 identical emails in 45 minutes" bug.
 *
 * This adds an explicit `sent_date` (the local calendar day a send is dedup'd
 * on; weekly summaries use the week-start date) and a UNIQUE index, so the job
 * can claim a send atomically: INSERT ... ON CONFLICT DO NOTHING RETURNING id.
 * If the row is claimed we send; if not, someone already did. A DB hiccup now
 * fails CLOSED (no email) instead of flooding.
 */
module.exports = {
  name: 'followup_email_log_dedup_unique',

  up: async (client) => {
    await client.query(
      `ALTER TABLE followup_email_log ADD COLUMN IF NOT EXISTS sent_date DATE`
    );
    // Backfill existing rows so the unique index can build.
    await client.query(
      `UPDATE followup_email_log
         SET sent_date = (sent_at AT TIME ZONE 'UTC')::date
       WHERE sent_date IS NULL`
    );
    // Collapse any pre-existing duplicates (keep the earliest id) so the unique
    // index doesn't fail to create.
    await client.query(
      `DELETE FROM followup_email_log a
         USING followup_email_log b
        WHERE a.id > b.id
          AND a.user_id = b.user_id
          AND a.email_type = b.email_type
          AND COALESCE(a.trigger_ref,'') = COALESCE(b.trigger_ref,'')
          AND a.sent_date = b.sent_date`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS followup_email_log_dedup
         ON followup_email_log (user_id, email_type, trigger_ref, sent_date)`
    );
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS followup_email_log_dedup`);
    await client.query(`ALTER TABLE followup_email_log DROP COLUMN IF EXISTS sent_date`);
  },
};
