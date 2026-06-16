#!/usr/bin/env node
'use strict';
/**
 * jobs/stash-purge.js — Delete expired email_tasks_stash rows.
 * Stash entries expire after 72h (unclaimed magic links). Runs daily at 2am UTC.
 */

const { Pool } = require('pg');
const { purgeExpiredStash } = require('../db/email-to-tasks');

if (!process.env.DATABASE_URL) {
  console.error('[stash-purge] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 2, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    const n = await purgeExpiredStash(pool);
    if (n > 0) console.log(`[stash-purge] Deleted ${n} expired stash entries`);
    else console.log('[stash-purge] Nothing to purge');
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[stash-purge] Fatal:', err.message);
  process.exit(1);
});
