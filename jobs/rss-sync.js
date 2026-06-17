#!/usr/bin/env node
'use strict';
/**
 * jobs/rss-sync.js — Fetch and cache RSS feeds for the News tab.
 * Runs every 20 minutes via render.yaml cron. Articles older than 48h are pruned.
 */

const { Pool } = require('pg');
const { fetchAllFeeds } = require('../routes/news');

if (!process.env.DATABASE_URL) {
  console.error('[rss-sync] DATABASE_URL not set'); process.exit(1);
}

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 3, connectionTimeoutMillis: 10000, statement_timeout: 20000,
  });
  try {
    await fetchAllFeeds(pool);
  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('[rss-sync] Fatal:', err.message);
  process.exit(1);
});
