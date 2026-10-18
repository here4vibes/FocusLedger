#!/usr/bin/env node
/**
 * jobs/renewalHeadsUpJob.js — hourly. At 10am in each user's own timezone,
 * push a "still worth it?" heads-up for annual/quarterly subscriptions that
 * renew within a week (lib/bill-guardian.js renewalHeadsUps). One push per
 * merchant per renewal date; respects the daily push cap. Home's bills card
 * shows the same subscription with Cancel / Keep / Not a subscription.
 * Never touches is_qa_user accounts (filtered here; usersWithActivePlaid
 * doesn't exclude them).
 */
'use strict';

const { initSentry, flushAndExit } = require('../lib/sentry');
initSentry('renewalHeadsUpJob');

const { Pool } = require('pg');
const billsDb = require('../db/bills');
const { detectStreams, renewalHeadsUps, headsUpMessage, _internal } = require('../lib/bill-guardian');
const tz = require('../lib/timezone');
const notif = require('../db/notifications');
const { sendPushToUser } = require('../lib/sendPushToUser');
const { isQaUser } = require('../db/users');
const { logFailure } = require('../lib/log-failure');

const SEND_HOUR = 10;

/** Heads-ups for one user. Exported for tests. @returns {Promise<number>} pushes attempted */
async function runForUser(pool, userId, { now = new Date(), push = sendPushToUser } = {}) {
  const zone = await tz.fetchUserTimezone(pool, userId);
  if (tz.getUserLocalHour(zone, now) !== SEND_HOUR) return 0;
  const localDate = tz.getUserLocalDate(zone);
  const todayMs = _internal.toDay(localDate);

  const [txs, prefs] = await Promise.all([billsDb.getRecentOutflows(pool, userId), billsDb.getBillPreferences(pool, userId)]);
  const prefsByKey = new Map(prefs.map(p => [p.merchant_key, p]));
  const due = renewalHeadsUps(detectStreams(txs, todayMs), prefsByKey, todayMs);

  let attempted = 0;
  for (const s of due) {
    const key = `renewal:${s.merchant_key}:${s.predicted_next}`;
    if (await notif.wasNotificationKeySent(pool, userId, key)) continue;
    if ((await notif.getTodayNotificationCount(pool, userId, localDate)) >= notif.DAILY_PUSH_CAP) break;
    await push(pool, userId, headsUpMessage(s, todayMs));
    await notif.recordNotificationSent(pool, userId, key, 'renewal_heads_up', localDate);
    attempted++;
  }
  return attempted;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3,
  });
  let attempted = 0, failed = 0, users = 0;
  try {
    for (const userId of await billsDb.usersWithActivePlaid(pool)) {
      try {
        if (await isQaUser(pool, userId)) continue;
        users++;
        attempted += await runForUser(pool, userId);
      } catch (e) {
        failed++;
        console.error('[renewal-heads-up] user failed:', e.message, '| user:', userId);
      }
    }
    // sendPushToUser is best-effort and doesn't report delivery: count attempts, not deliveries.
    console.log(`[renewal-heads-up] checked ${users} user(s): ${attempted} heads-up push(es) attempted, ${failed} failed`);
  } catch (e) {
    console.error('[renewal-heads-up] Fatal:', e.message);
    await pool.end().catch(logFailure('[renewal-heads-up]', 'pool.end'));
    flushAndExit(1);
    return;
  }
  await pool.end();
}

if (require.main === module) main();

module.exports = { runForUser, SEND_HOUR };
