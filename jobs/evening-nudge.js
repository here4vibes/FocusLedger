#!/usr/bin/env node
'use strict';
/**
 * jobs/evening-nudge.js — Send evening reflection nudges at each user's configured hour.
 * Runs every 5 minutes via render.yaml cron. Different from evening-checkin.js:
 * this sends the "How did today go?" general reflection prompt; evening-checkin.js
 * sends the spending triage nudge for users with a Plaid connection.
 */

const { Pool } = require('pg');
const { sendEveningNudges } = require('../eveningNudge');

if (!process.env.DATABASE_URL) {
  console.error('[evening-nudge] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await sendEveningNudges(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[evening-nudge] Fatal:', err.message);
  process.exit(1);
});
