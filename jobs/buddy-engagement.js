#!/usr/bin/env node
'use strict';
/**
 * jobs/buddy-engagement.js — Buddy streak tracking and lapse re-engagement.
 * Runs hourly via render.yaml cron. Escalates missed check-ins: push on day 3,
 * email on day 5 and day 14 of consecutive lapse.
 */

const { Pool } = require('pg');
const { runBuddyEngagementCheck } = require('../buddyEngagementCron');

if (!process.env.DATABASE_URL) {
  console.error('[buddy-engagement] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await runBuddyEngagementCheck(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[buddy-engagement] Fatal:', err.message);
  process.exit(1);
});
