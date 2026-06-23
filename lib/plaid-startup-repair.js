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
 * 8. One-time: confirm all unconfirmed non-pending plaid_transactions to expenses
 */

const CURSOR_RESET_MIGRATION   = 'reset_plaid_cursors_for_backfill';
const CONFIRM_BACKLOG_MIGRATION = 'auto_confirm_plaid_backlog';

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

    // 8. One-time: confirm all unconfirmed non-pending plaid_transactions to expenses.
    //    Root cause: plaid-sync.js (6am cron) inserts to plaid_transactions but never
    //    confirmed them to expenses. This backfill runs once on next deploy to surface
    //    the historical transactions users are missing in their money tab.
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

            // Dedup check first — expenses.plaid_transaction_id has no UNIQUE constraint
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

