'use strict';
/**
 * jobs/evening-checkin.js — Evening check-in notification sender.
 *
 * Runs hourly via render.yaml; each user is processed only in the hour of their
 * evening_time (default 20:00) in their own timezone. (It used to run once at
 * 20:00 UTC — 4pm Eastern, 1pm Pacific — and never read evening_time.)
 * Sends push notifications to users who:
 *   1. Have a Plaid token connected
 *   2. Have transactions today
 *   3. Have evening check-in enabled
 *   4. Have not already completed today's spending session
 *
 * Guards: skipped entirely when IN_PROCESS_CRONS_ENABLED !== 'true'
 * (Blaxel shadow migration sets this to false; primary Render handles crons via render.yaml).
 *
 * Batches users in chunks of 50 to avoid overwhelming the notification infrastructure.
 * Logs all outcomes (sent, skipped) to console.
 *
 */

const { initSentry, flushAndExit } = require('../lib/sentry');
initSentry('evening-checkin'); // console.error → Sentry for this cron (see lib/sentry.js)

const { Pool } = require('pg');
const { getLocalDateParts } = require('../lib/timezone');

if (!process.env.DATABASE_URL) {
  console.error('[evening-checkin] DATABASE_URL not set — exiting');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

const CHUNK_SIZE = 50;

async function fetchUsersWithEveningEnabled() {
  const result = await pool.query(`
    SELECT u.id, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS tz,
           COALESCE(NULLIF(p.evening_time, ''), '20:00') AS evening_time
    FROM users u
    JOIN user_notification_prefs p ON p.user_id = u.id
    WHERE p.evening_enabled = true
      AND COALESCE(u.is_qa_user, false) = false
  `);
  return result.rows;
}

/** Users whose evening_time hour is the current hour where they are. */
function dueNow(users, now = new Date()) {
  return users.filter(u => {
    const target = parseInt(String(u.evening_time).split(':')[0], 10);
    const hour = Number.isFinite(target) && target >= 0 && target <= 23 ? target : 20;
    return getLocalDateParts(u.tz, now).hour === hour;
  });
}

async function processChunk(users) {
  let processed = 0;
  let sent = 0;
  let skipped = 0;

  const { send_evening_checkin } = require('../services/NotificationService');

  for (const user of users) {
    try {
      const result = await send_evening_checkin(pool, user.id);
      if (result.sent) {
        sent++;
        console.log(`[evening-checkin] Sent to user ${user.id}`);
      } else {
        skipped++;
        console.log(`[evening-checkin] Skipped user ${user.id}: ${result.reason}`);
      }
    } catch (err) {
      console.warn(`[evening-checkin] Error for user ${user.id}:`, err.message);
      skipped++;
    }
    processed++;
  }

  return { processed, sent, skipped };
}

async function main() {
  console.log('[evening-checkin] Starting evening check-in job...');

  const enabled = await fetchUsersWithEveningEnabled();
  const users = dueNow(enabled);
  console.log(`[evening-checkin] ${users.length} of ${enabled.length} enabled users are at their evening hour`);

  if (users.length === 0) {
    console.log('[evening-checkin] No users to process — exiting');
    await pool.end();
    return;
  }

  let totalSent = 0;
  let totalSkipped = 0;

  // Process in chunks of 50
  for (let i = 0; i < users.length; i += CHUNK_SIZE) {
    const chunk = users.slice(i, i + CHUNK_SIZE);
    const { sent, skipped } = await processChunk(chunk);
    totalSent += sent;
    totalSkipped += skipped;
    console.log(`[evening-checkin] Chunk ${Math.floor(i / CHUNK_SIZE) + 1}: sent=${sent} skipped=${skipped}`);
  }

  console.log(`[evening-checkin] Done — sent=${totalSent} skipped=${totalSkipped}`);
  await pool.end();
}

main().catch(err => {
  console.error('[evening-checkin] Fatal error:', err.message);
  pool.end().then(() => flushAndExit(1)).catch(() => flushAndExit(1));
});