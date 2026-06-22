'use strict';
/**
 * lib/plaid-startup-repair.js — runs on every server start, bypasses migrate.js.
 *
 * Fixes two issues that migrate.js never got to run:
 *
 * 1. UNIQUE index on plaid_transactions.transaction_id
 * 2. UNIQUE index on _migrations.name (prevents duplicate rows from repeated boots)
 * 3. One-time cursor reset for historical backfill (guarded by _migrations row)
 *
 * Both ops are non-blocking: errors are logged but do not prevent server startup.
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

  } catch (e) {
    console.error('[startup] repairPlaidSchema failed:', e.message);
  } finally {
    if (client) client.release();
  }
};

