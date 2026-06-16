#!/usr/bin/env node
'use strict';
/**
 * jobs/email-crons.js — Weekly nudges, re-engagement emails, Pro expiry reminders.
 * Runs every 10 minutes via render.yaml cron. Each send function is idempotent
 * (checks email_log to avoid re-sending within the same day/week window).
 */

const { Pool } = require('pg');
const { runEmailCrons } = require('../emailCron');

if (!process.env.DATABASE_URL) {
  console.error('[email-crons] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await runEmailCrons(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[email-crons] Fatal:', err.message);
  process.exit(1);
});
