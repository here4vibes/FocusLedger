'use strict';
/**
 * lib/plaid-startup-repair.js — runs on every server start, bypasses migrate.js.
 *
 * Fixes two issues that migrate.js never got to run:
 *
 * 1. UNIQUE index on plaid_transactions.transaction_id
 *    Without it, ON CONFLICT (transaction_id) DO NOTHING throws and every insert
 *    is silently swallowed while the cursor still advances. CREATE UNIQUE INDEX IF
 *    NOT EXISTS is idempotent and safe to call every boot.
 *
 * 2. Cursor reset for historical backfill (one-time only)
 *    All existing cursors are past the historical window. We reset them to NULL so
 *    the next sync re-fetches from the beginning. Guarded by a _migrations row so
 *    it only runs once — subsequent boots skip it.
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

    // 2. One-time cursor reset — only runs if not already recorded in _migrations
    let alreadyReset = false;
    try {
      const { rows } = await client.query(
        `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
        [CURSOR_RESET_MIGRATION]
      );
      alreadyReset = rows.length > 0;
    } catch (_) { /* _migrations table may not exist yet — treat as not done */ }

    if (!alreadyReset) {
      try {
        await client.query(`UPDATE plaid_items SET cursor = NULL WHERE cursor IS NOT NULL`);
        // Record in _migrations so this doesn't fire again after the next deploy
        await client.query(
          `INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [CURSOR_RESET_MIGRATION]
        );
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
