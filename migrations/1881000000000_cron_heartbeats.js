'use strict';
/**
 * cron_heartbeats — one row per cron job, holding when it last ran and the run
 * before that. Jobs that only send to users whose local hour matches (evening
 * check-in, cold-start nudge) read the gap to notice they're being run on a
 * non-hourly Render schedule (lib/cron-cadence.js, docs/render-crons.md).
 *
 * Every column the code omits on INSERT has a default.
 */
module.exports = {
  name: 'cron_heartbeats',
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_heartbeats (
        job_name        TEXT        PRIMARY KEY,
        last_run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        previous_run_at TIMESTAMPTZ,
        run_count       INTEGER     NOT NULL DEFAULT 1
      )
    `);
  },
  async down(client) {
    await client.query('DROP TABLE IF EXISTS cron_heartbeats');
  },
};
