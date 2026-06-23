'use strict';
/**
 * lib/plaid-startup-repair.js — startup schema verification.
 *
 * Schema changes now live exclusively in migrations/. This file verifies that
 * critical indexes exist (loudly logging if they don't) and runs two
 * one-time data migrations that are too risky to re-run via a migration file:
 *   - cursor reset for historical backfill (guarded by _migrations row)
 *   - auto-confirm unconfirmed non-pending plaid_transactions to expenses (guarded)
 *
 * It no longer creates any indexes or DDL — if a critical index is missing it
 * means a migration hasn't run and that needs to be fixed at the deployment
 * level, not masked at startup.
 */

const CURSOR_RESET_MIGRATION    = 'reset_plaid_cursors_for_backfill';
const CONFIRM_BACKLOG_MIGRATION = 'auto_confirm_plaid_backlog';

// Indexes that must exist for the Plaid sync to work correctly.
const CRITICAL_INDEXES = [
  { name: 'plaid_txs_transaction_id_unique',  table: 'plaid_transactions' },
  { name: 'plaid_accounts_account_id_unique', table: 'plaid_accounts' },
  { name: 'plaid_items_institution_user_unique', table: 'plaid_items' },
];

module.exports = async function repairPlaidSchema(pool) {
  let client;
  try {
    client = await pool.connect();

    // ── Verify critical indexes exist (DDL lives in migrations, not here) ────
    for (const idx of CRITICAL_INDEXES) {
      try {
        const { rows } = await client.query(
          `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1 LIMIT 1`,
          [idx.name]
        );
        if (!rows.length) {
          console.warn(
            `[startup] MISSING INDEX: ${idx.name} on ${idx.table} — ` +
            `run migrations to create it. ON CONFLICT clauses on this table will fail.`
          );
        }
      } catch (e) {
        console.error('[startup] index check failed for', idx.name, ':', e.message);
      }
    }

    // ── One-time: cursor reset for historical backfill ───────────────────────
    // Resets plaid_items.cursor to NULL so the next sync re-fetches full history.
    // Guarded by _migrations row — only runs once across all deploys.
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
        try {
          await client.query(
            `INSERT INTO _migrations (name) VALUES ($1)`,
            [CURSOR_RESET_MIGRATION]
          );
        } catch (_) { /* duplicate row is fine — guard already prevents re-run */ }
        console.log('[startup] plaid_items cursors reset for historical backfill');
      } catch (e) {
        console.error('[startup] plaid cursor reset failed:', e.message);
      }
    }

    // ── One-time: confirm unconfirmed non-pending transactions to expenses ───
    // Historical transactions inserted by the cron but never confirmed.
    // Guarded by _migrations row — only runs once.
    let alreadyConfirmed = false;
    try {
      const { rows: cr } = await client.query(
        `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
        [CONFIRM_BACKLOG_MIGRATION]
      );
      alreadyConfirmed = cr.length > 0;
    } catch (_) {}

    if (!alreadyConfirmed) {
      try {
        const { rows: pending } = await client.query(`
          SELECT id, user_id, transaction_id, amount, description, merchant_name,
                 category_id, transaction_date
          FROM plaid_transactions
          WHERE is_confirmed = false AND is_pending = false
        `);
        let confirmed = 0;
        for (const tx of pending) {
          try {
            const expDate = tx.transaction_date
              ? String(tx.transaction_date).slice(0, 10)
              : new Date().toISOString().split('T')[0];

            let expenseId = null;
            if (tx.transaction_id) {
              const { rows: dup } = await client.query(
                'SELECT id FROM expenses WHERE plaid_transaction_id = $1 LIMIT 1',
                [tx.transaction_id]
              );
              expenseId = dup[0]?.id || null;
            }

            if (!expenseId) {
              const cols = ['user_id', 'amount', 'description', 'expense_date', 'source', 'plaid_transaction_id'];
              const vals = [tx.user_id, parseFloat(tx.amount), tx.description || tx.merchant_name || 'Unknown', expDate, 'plaid', tx.transaction_id];
              if (tx.category_id != null) { cols.push('category_id'); vals.push(tx.category_id); }
              const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
              const { rows: expRows } = await client.query(
                `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING id`, vals
              );
              expenseId = expRows[0]?.id || null;
            }

            if (expenseId) {
              await client.query(
                'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
                [expenseId, tx.id]
              );
              confirmed++;
            }
          } catch (e) {
            console.error('[startup] Error confirming plaid tx', tx.id, ':', e.message);
          }
        }

        try {
          await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [CONFIRM_BACKLOG_MIGRATION]);
        } catch (_) {}
        console.log(`[startup] auto-confirmed ${confirmed} unconfirmed Plaid transactions to expenses`);
      } catch (e) {
        console.error('[startup] plaid backlog confirm failed:', e.message);
      }
    }

  } catch (e) {
    console.error('[startup] repairPlaidSchema failed:', e.message);
  } finally {
    if (client) client.release();
  }
};
