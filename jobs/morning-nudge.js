#!/usr/bin/env node
'use strict';
/**
 * jobs/morning-nudge.js — Send morning nudges to users at their configured hour.
 * Runs every 5 minutes via render.yaml cron. Timezone-aware: each user's local
 * hour is checked so nudges fire at the right local time regardless of UTC.
 */

const { Pool } = require('pg');
const { sendMorningNudges } = require('../morningNudge');

if (!process.env.DATABASE_URL) {
  console.error('[morning-nudge] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await sendMorningNudges(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[morning-nudge] Fatal:', err.message);
  process.exit(1);
});
