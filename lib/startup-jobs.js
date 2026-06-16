'use strict';
/**
 * lib/startup-jobs.js — in-process background jobs started at server launch.
 *
 * NOTE: These run alongside the polsia.toml cron entries in jobs/. The
 * polsia crons cover scheduled one-shot runs; these in-process loops handle
 * higher-frequency nudges and real-time checks within a single Render dyno.
 */

const { purgeExpiredStash }       = require('../db/email-to-tasks');
const { scheduleMorningNudges }   = require('../morningNudge');
const { scheduleEveningNudges }   = require('../eveningNudge');
const { scheduleTaskDeadlineNudges } = require('../taskDeadlineNudge');
const { scheduleEmailCrons }      = require('../emailCron');
const { schedulePlaidDailySync }  = require('../plaidDailySync');
const { scheduleBuddyEngagementCron } = require('../buddyEngagementCron');
const { runV2LaunchCampaign }     = require('./v2LaunchCampaign');

module.exports = function startBackgroundJobs(pool, newsRouteFactory) {
  newsRouteFactory.startRssCron(pool);
  scheduleMorningNudges(pool);
  scheduleEveningNudges(pool);
  scheduleTaskDeadlineNudges(pool);
  scheduleEmailCrons(pool);
  schedulePlaidDailySync(pool);
  scheduleBuddyEngagementCron(pool);

  // email_tasks_stash rows expire after 72h — clean up once a day
  const runStashPurge = () => purgeExpiredStash(pool)
    .then(n => n > 0 && console.log(`[email-to-tasks] Purged ${n} expired stash entries`))
    .catch(err => console.error('[email-to-tasks] Stash cleanup error:', err.message));
  setTimeout(() => { runStashPurge(); setInterval(runStashPurge, 24 * 60 * 60 * 1000); }, 60 * 1000);

  // One-shot: fires v2 launch campaign once; self-disabling after all users have been sent
  setTimeout(() => runV2LaunchCampaign(pool), 30 * 1000);
};
