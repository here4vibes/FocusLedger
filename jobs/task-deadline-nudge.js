#!/usr/bin/env node
'use strict';
/**
 * jobs/task-deadline-nudge.js — Push notifications for overdue or imminent tasks.
 * Runs every 15 minutes via render.yaml cron. Respects the per-user daily push cap.
 */

const { initSentry, flushAndExit } = require('../lib/sentry');
initSentry('task-deadline-nudge'); // console.error → Sentry for this cron (see lib/sentry.js)

const { Pool } = require('pg');
const { sendTaskDeadlineNudges } = require('../taskDeadlineNudge');

if (!process.env.DATABASE_URL) {
  console.error('[task-deadline-nudge] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await sendTaskDeadlineNudges(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[task-deadline-nudge] Fatal:', err.message);
  flushAndExit(1);
});
