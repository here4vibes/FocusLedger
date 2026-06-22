'use strict';
/**
 * lib/plaid-startup-repair.js — runs on every server start, bypasses migrate.js.
 *
 * Ensures UNIQUE indexes that may be missing in production because tables
 * pre-date the constraint being added to the CREATE TABLE DDL. All ops are
 * idempotent (CREATE UNIQUE INDEX IF NOT EXISTS) and non-blocking.
 *
 * 1. UNIQUE index on plaid_transactions.transaction_id
 * 2. UNIQUE index on _migrations.name (prevents duplicate rows from repeated boots)
 * 3. One-time cursor reset for historical backfill (guarded by _migrations row)
 * 4. UNIQUE index on transaction_classifications (transaction_id, user_id)
 * 5. UNIQUE index on routine_nudge_events (routine_id, nudge_date)
 * 6. UNIQUE index on news_cache (url)
 * 7. UNIQUE index on lead_magnet_emails (email, lead_magnet_type)
 */

const CURSOR_RESET_MIGRATION = 'reset_plaid_cursors_for_backfill';

module.exports = async function repairPlaidSchema(pool) {
  let client;
  try {
    client = await pool.connect();

    // 1. Ensure UNIQUE index on plaid_transactions.transaction_id (idempotent)
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS plaid_txs_transaction_id_unique
          ON plaid_transactions (transaction_id)
          WHERE transaction_id IS NOT NULL
      `);
      console.log('[startup] plaid_transactions UNIQUE index ensured');
    } catch (e) {
      console.error('[startup] plaid_transactions UNIQUE index failed:', e.message);
    }

    // 2. Ensure UNIQUE index on _migrations.name so ON CONFLICT works everywhere
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS migrations_name_unique
          ON _migrations (name)
      `);
    } catch (e) {
      // Non-fatal — may already exist, or _migrations doesn't exist yet
    }

    // 3. One-time cursor reset — only runs if not already recorded in _migrations
    let alreadyReset = false;
    try {
      const { rows } = await client.query(
        `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
        [CURSOR_RESET_MIGRATION]
      );
      alreadyReset = rows.length > 0;
    } catch (_) { /* _migrations table may not exist yet */ }

    if (!alreadyReset) {
      try {
        await client.query(`UPDATE plaid_items SET cursor = NULL WHERE cursor IS NOT NULL`);
        // Plain INSERT — no ON CONFLICT needed since we already checked above
        try {
          await client.query(
            `INSERT INTO _migrations (name) VALUES ($1)`,
            [CURSOR_RESET_MIGRATION]
          );
        } catch (_) { /* duplicate row OK — guard already prevents re-running */ }
        console.log('[startup] plaid_items cursors reset for historical backfill');
      } catch (e) {
        console.error('[startup] plaid cursor reset failed:', e.message);
      }
    }

    // 4. UNIQUE index on transaction_classifications (transaction_id, user_id)
    //    Backs ON CONFLICT in db/transactions.js and db/spendingSessions.js
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS tc_txid_userid_unique
          ON transaction_classifications (transaction_id, user_id)
      `);
    } catch (e) {
      console.error('[startup] transaction_classifications UNIQUE index failed:', e.message);
    }

    // 5. UNIQUE index on routine_nudge_events (routine_id, nudge_date)
    //    Backs ON CONFLICT in db/routineNudges.js
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS routine_nudge_events_rid_date_unique
          ON routine_nudge_events (routine_id, nudge_date)
      `);
    } catch (e) {
      console.error('[startup] routine_nudge_events UNIQUE index failed:', e.message);
    }

    // 6. UNIQUE index on news_cache (url)
    //    Backs ON CONFLICT in routes/news.js; non-fatal if table doesn't exist yet
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS news_cache_url_unique
          ON news_cache (url)
      `);
    } catch (e) {
      if (!e.message.includes('does not exist')) {
        console.error('[startup] news_cache UNIQUE index failed:', e.message);
      }
    }

    // 7. UNIQUE index on lead_magnet_emails (email, lead_magnet_type)
    //    Backs ON CONFLICT in db/lead-magnets.js
    try {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS lead_magnet_emails_email_type_unique
          ON lead_magnet_emails (email, lead_magnet_type)
      `);
    } catch (e) {
      console.error('[startup] lead_magnet_emails UNIQUE index failed:', e.message);
    }

  } catch (e) {
    console.error('[startup] repairPlaidSchema failed:', e.message);
  } finally {
    if (client) client.release();
  }
};

