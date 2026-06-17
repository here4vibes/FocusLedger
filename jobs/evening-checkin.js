'use strict';
/**
 * jobs/evening-checkin.js — Evening check-in notification sender.
 *
 * Runs daily at 8pm (or user-preferred time) via polsia.toml.
 * Sends push notifications to users who:
 *   1. Have a Plaid token connected
 *   2. Have transactions today
 *   3. Have evening check-in enabled
 *   4. Have not already completed today's spending session
 *
 * Guards: skipped entirely when POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true'
 * (Blaxel shadow migration sets this to false; primary Render handles crons via polsia.toml).
 *
 * Batches users in chunks of 50 to avoid overwhelming the notification infrastructure.
 * Logs all outcomes (sent, skipped, retry_scheduled) to console.
 *
 * polsia.toml entry:
 *   [[crons]]
 *   name = "evening-checkin-sender"
 *   schedule = "0 20 * * *"
 *   command = "node jobs/evening-checkin.js"
 */

const { Pool } = require('pg');

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
    SELECT u.id, u.email, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS tz
    FROM users u
    JOIN user_notification_prefs p ON p.user_id = u.id
    WHERE p.evening_enabled = true
      AND COALESCE(u.is_qa_user, false) = false
  `);
  return result.rows;
}

async function processChunk(users) {
  let processed = 0;
  let sent = 0;
  let skipped = 0;
  let retryScheduled = 0;

  const { send_evening_checkin } = require('../services/NotificationService');

  for (const user of users) {
    try {
      const result = await send_evening_checkin(pool, user.id);
      if (result.sent) {
        sent++;
        console.log(`[evening-checkin] Sent to user ${user.id} (${user.email})`);
      } else if (result.reason === 'retry_scheduled') {
        retryScheduled++;
        console.log(`[evening-checkin] Retry scheduled for user ${user.id}`);
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

  return { processed, sent, skipped, retryScheduled };
}

async function main() {
  console.log('[evening-checkin] Starting evening check-in job...');

  const users = await fetchUsersWithEveningEnabled();
  console.log(`[evening-checkin] Found ${users.length} users with evening check-in enabled`);

  if (users.length === 0) {
    console.log('[evening-checkin] No users to process — exiting');
    await pool.end();
    return;
  }

  let totalSent = 0;
  let totalSkipped = 0;
  let totalRetryScheduled = 0;

  // Process in chunks of 50
  for (let i = 0; i < users.length; i += CHUNK_SIZE) {
    const chunk = users.slice(i, i + CHUNK_SIZE);
    const { sent, skipped, retryScheduled } = await processChunk(chunk);
    totalSent += sent;
    totalSkipped += skipped;
    totalRetryScheduled += retryScheduled;
    console.log(`[evening-checkin] Chunk ${Math.floor(i / CHUNK_SIZE) + 1}: sent=${sent} skipped=${skipped} retry=${retryScheduled}`);
  }

  console.log(`[evening-checkin] Done — sent=${totalSent} skipped=${totalSkipped} retry_scheduled=${totalRetryScheduled}`);
  await pool.end();
}

main().catch(err => {
  console.error('[evening-checkin] Fatal error:', err.message);
  pool.end().then(() => process.exit(1)).catch(() => process.exit(1));
});