#!/usr/bin/env node
/**
 * jobs/routineNudgeCheck.js — Scheduled routine nudge evaluation job.
 * Runs via render.yaml [[crons]] every 15 minutes.
 *
 * For each user with active routines, checks whether any routines are missed
 * (past the nudge_after_hour trigger and no tasks completed) and generates
 * nudge events. These events are surfaced the next time the user opens the app.
 *
 * Delivery is IN-APP ONLY via GET /api/buddy/session-status returning routineNudges.
 * No push notifications are sent here — by design for ADHD users.
 *
 * Idempotent: getOrCreateNudgeEvent uses ON CONFLICT DO UPDATE, so re-runs
 * are safe.
 */
'use strict';

const { Pool } = require('pg');
const { getUserLocalDate } = require('../lib/timezone');
const { checkAndGenerateNudges } = require('../lib/routineNudgeEngine');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
    statement_timeout: 20000,
  });

  try {
    // Fetch all users who have at least one active routine
    const usersResult = await pool.query(`
      SELECT DISTINCT u.id, COALESCE(NULLIF(u.timezone, ''), 'America/New_York') AS tz
      FROM users u
      INNER JOIN routines r ON r.user_id = u.id AND r.is_active = true
    `);

    console.log(`[routineNudgeCheck] Checking ${usersResult.rows.length} users`);

    let generated = 0;
    for (const user of usersResult.rows) {
      try {
        const localDate = getUserLocalDate(user.tz);
        const nudges = await checkAndGenerateNudges(pool, user.id, localDate, user.tz);
        generated += nudges.length;
      } catch (userErr) {
        // Log per-user errors but continue processing others
        console.error(`[routineNudgeCheck] user ${user.id} error:`, userErr.message);
      }
    }

    console.log(`[routineNudgeCheck] Done — generated ${generated} nudge event(s)`);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[routineNudgeCheck] Fatal error:', err.message);
  process.exit(1);
});
