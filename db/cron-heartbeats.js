'use strict';
/**
 * db/cron-heartbeats.js — cron_heartbeats: when each cron job last ran.
 * Read by lib/cron-cadence.js.
 */

/**
 * Record that `jobName` is running now.
 * @returns {Promise<{ previousRunAt: Date|null, thisRunAt: Date }>} previousRunAt
 *   is null on the job's first recorded run.
 */
async function recordRun(pool, jobName) {
  const { rows } = await pool.query(`
    INSERT INTO cron_heartbeats (job_name, last_run_at)
    VALUES ($1, NOW())
    ON CONFLICT (job_name) DO UPDATE
      SET previous_run_at = cron_heartbeats.last_run_at,
          last_run_at     = NOW(),
          run_count       = cron_heartbeats.run_count + 1
    RETURNING previous_run_at, last_run_at`, [jobName]);
  return { previousRunAt: rows[0].previous_run_at, thisRunAt: rows[0].last_run_at };
}

module.exports = { recordRun };
