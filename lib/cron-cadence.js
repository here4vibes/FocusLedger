'use strict';
/**
 * lib/cron-cadence.js — notice when an hourly job isn't being run hourly.
 *
 * Some jobs send only to users whose LOCAL hour matches right now (evening
 * check-in at each user's evening_time, cold-start nudge at 10:00 local). They
 * are correct only if Render runs them every hour. Render Blueprint sync is
 * off for this account, so render.yaml is documentation: a schedule changed
 * there does nothing until someone edits the cron in the Render dashboard. Run
 * once a day, such a job matches almost nobody and the push silently never
 * goes out.
 *
 * So each run records a heartbeat (db/cron-heartbeats.js) and, when the
 * previous run was too long ago, logs a console.error naming the Render cron
 * to fix. console.error reaches Sentry (lib/sentry.js). No scheduler here: the
 * job still runs only when Render starts it.
 */
const { recordRun } = require('../db/cron-heartbeats');

// An hourly cron's runs are 60 minutes apart; 90 allows a slow start or a
// late run without crying wolf, and still catches every-2-hours and daily.
const MAX_HOURLY_GAP_MINUTES = 90;

/**
 * Pure: is the gap since the previous run too long for an hourly job?
 * @param {Date|string|null} previousRunAt null = first recorded run (nothing to compare)
 * @param {Date} now
 * @returns {{ ok: true, gapMinutes: number|null } | { ok: false, gapMinutes: number }}
 */
function hourlyCadence(previousRunAt, now = new Date(), maxGapMinutes = MAX_HOURLY_GAP_MINUTES) {
  if (!previousRunAt) return { ok: true, gapMinutes: null };
  const prev = new Date(previousRunAt).getTime();
  if (!Number.isFinite(prev)) return { ok: true, gapMinutes: null };
  const gapMinutes = Math.round((now.getTime() - prev) / 60000);
  return gapMinutes > maxGapMinutes ? { ok: false, gapMinutes } : { ok: true, gapMinutes };
}

function describeGap(minutes) {
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** The exact line logged; one stable sentence per cron so Sentry groups it. */
function cadenceMessage({ renderCron, sends, gapMinutes }) {
  return `Render cron "${renderCron}" is not running hourly: the previous run was ${describeGap(gapMinutes)} ago. `
    + `This job sends ${sends}, so on any other schedule most users never get it. `
    + `Fix: Render dashboard → cron "${renderCron}" → Settings → Schedule → 0 * * * * (see docs/render-crons.md).`;
}

/**
 * Record this run and log loudly if the job isn't on an hourly cadence.
 * Never throws: a heartbeat failure is logged and the job carries on.
 *
 * @param {import('pg').Pool} pool
 * @param {{ job: string, prefix: string, renderCron: string, sends: string }} opts
 *   job: heartbeat key · prefix: log prefix like '[evening-checkin]' ·
 *   renderCron: the cron's name in the Render dashboard · sends: what it sends and when
 * @returns {Promise<{ ok: boolean, gapMinutes: number|null }>}
 */
async function checkHourlyCadence(pool, { job, prefix, renderCron, sends }) {
  let previousRunAt;
  let thisRunAt;
  try {
    ({ previousRunAt, thisRunAt } = await recordRun(pool, job));
  } catch (e) {
    console.error(`${prefix} cron heartbeat failed (cadence not checked, job continues):`, e.message, '| job:', job);
    return { ok: true, gapMinutes: null };
  }
  const result = hourlyCadence(previousRunAt, thisRunAt ? new Date(thisRunAt) : new Date());
  if (!result.ok) {
    console.error(`${prefix} ${cadenceMessage({ renderCron, sends, gapMinutes: result.gapMinutes })}`);
  } else if (result.gapMinutes === null) {
    console.log(`${prefix} first recorded run; cadence is checked from the next run on`);
  }
  return result;
}

module.exports = { checkHourlyCadence, hourlyCadence, cadenceMessage, describeGap, MAX_HOURLY_GAP_MINUTES };
