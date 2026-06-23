'use strict';
/**
 * jobs/plaid-sync.js — Daily Plaid transaction sync.
 *
 * Runs daily at 6am via polsia.toml.
 * For each user with a plaid_token (plaid_items row):
 *   1. Calls Plaid transactionsSync (cursor-based) to pull new transactions.
 *   2. Inserts new transactions into plaid_transactions table.
 *   3. Emits transactions.synced event to events table.
 *
 * Guards: skipped entirely when POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true'
 * (Blaxel shadow migration sets this to false; primary Render handles crons via polsia.toml).
 *
 * Batches users in chunks of 50 to avoid Plaid API rate limits.
 * Uses the same encryption/decryption pattern as routes/plaid.js and plaidDailySync.js.
 *
 * polsia.toml entry:
 *   [[crons]]
 *   name = "plaid-daily-sync"
 *   schedule = "0 6 * * *"
 *   command = "node jobs/plaid-sync.js"
 */

const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('[plaid-sync] DATABASE_URL not set — exiting');
  process.exit(1);
}

if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
  console.log('[plaid-sync] PLAID_CLIENT_ID or PLAID_SECRET not set — exiting');
  process.exit(0);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

const CHUNK_SIZE = 50;

// ── Plaid client ─────────────────────────────────────────────────────────────
let plaid = null;
try {
  const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
  const config = new Configuration({
    basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
        'PLAID-SECRET': process.env.PLAID_SECRET,
      }
    }
  });
  plaid = new PlaidApi(config);
} catch (e) {
  console.error('[plaid-sync] Failed to initialize Plaid client:', e.message);
  process.exit(1);
}

// ── Encryption ──────────────────────────────────────────────────────────────
const _encKey = Buffer.from(
  crypto.createHash('sha256')
    .update(process.env.PLAID_ENCRYPTION_KEY || process.env.JWT_SECRET || 'focusledger-plaid-enc')
    .digest('hex'),
  'hex'
).subarray(0, 32);

function decryptToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const data = Buffer.from(ciphertext, 'base64');
    if (data.length < 29) return ciphertext; // plaintext legacy
    const iv  = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const enc = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', _encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext;
  }
}

// ── Category mapping ─────────────────────────────────────────────────────────
const CAT_MAP = {
  GROCERIES: 'Groceries', FOOD_AND_DRINK: 'Food & Dining', RESTAURANTS: 'Food & Dining',
  TRANSPORTATION: 'Transport', TRAVEL: 'Transport',
  GENERAL_MERCHANDISE: 'Shopping', CLOTHING_AND_ACCESSORIES: 'Shopping',
  UTILITIES: 'Bills & Utilities', BILL_PAYMENTS: 'Bills & Utilities',
  ENTERTAINMENT: 'Entertainment', RECREATION: 'Entertainment',
  MEDICAL: 'Health', PERSONAL_CARE: 'Health', FITNESS: 'Health',
};

function classifyCategory(tx) {
  if (tx.personal_finance_category) {
    const primary = tx.personal_finance_category.primary;
    if (primary === 'FOOD_AND_DRINK' && tx.personal_finance_category.detailed?.includes('GROCERY')) {
      return 'Groceries';
    }
    return CAT_MAP[primary] || 'Other';
  }
  if (tx.category && tx.category.length > 0) {
    const s = tx.category.join(' ').toLowerCase();
    if (s.includes('grocer')) return 'Groceries';
    if (s.includes('food') || s.includes('restaurant')) return 'Food & Dining';
    if (s.includes('transport') || s.includes('travel')) return 'Transport';
    if (s.includes('shop')) return 'Shopping';
    if (s.includes('utility')) return 'Bills & Utilities';
    if (s.includes('health') || s.includes('medical')) return 'Health';
    if (s.includes('entertainment')) return 'Entertainment';
  }
  return 'Other';
}

// ── Sync one item ────────────────────────────────────────────────────────────
async function syncOneItem(item) {
  const accessToken = decryptToken(item.access_token);
  let cursor = item.cursor || null;
  let hasMore = true;
  let added = 0;

  // Build account_id → plaid_accounts.id map
  // Query by user_id (not just plaid_item_id) so accounts stored under older
  // plaid_item rows from past reconnects are still found.
  const accResult = await pool.query(
    `SELECT id, account_id FROM plaid_accounts
     WHERE plaid_item_id = $1 OR (user_id = $2 AND plaid_item_id IS NOT NULL)`,
    [item.id, item.user_id]
  );
  const accMap = {};
  for (const a of accResult.rows) accMap[a.account_id] = a.id;

  // Build category map
  const catResult = await pool.query('SELECT id, LOWER(name) AS name FROM categories');
  const catMap = {};
  for (const c of catResult.rows) catMap[c.name] = c.id;

  while (hasMore) {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 100,
    });

    const { added: newTxs, removed, next_cursor, has_more } = response.data;

    for (const tx of newTxs) {
      if (tx.amount <= 0) continue; // skip credits/refunds
      const plaidAccountId = accMap[tx.account_id];
      if (!plaidAccountId) continue;

      const catName = classifyCategory(tx);
      const catId = catMap[catName.toLowerCase()] || catMap['other'] || null;
      const plaidCat = tx.personal_finance_category
        ? `${tx.personal_finance_category.primary}/${tx.personal_finance_category.detailed || ''}`
        : (tx.category ? tx.category.join(' > ') : null);

      try {
        // Dedup by SELECT first — avoids ON CONFLICT (transaction_id) which requires
        // a non-partial UNIQUE index. Works regardless of schema state.
        let plaidTx = null;
        if (tx.transaction_id) {
          const { rows: existingRows } = await pool.query(
            'SELECT id, transaction_id, amount, description, merchant_name, category_id, transaction_date FROM plaid_transactions WHERE transaction_id = $1 LIMIT 1',
            [tx.transaction_id]
          );
          if (existingRows.length) {
            plaidTx = existingRows[0];
          }
        }
        if (!plaidTx) {
          const { rows: ptRows } = await pool.query(
            `INSERT INTO plaid_transactions
               (plaid_account_id, user_id, transaction_id, amount, description, merchant_name,
                category_id, plaid_category, transaction_date, is_pending)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, transaction_id, amount, description, merchant_name, category_id, transaction_date`,
            [plaidAccountId, item.user_id, tx.transaction_id, tx.amount,
             tx.merchant_name || tx.name || 'Unknown', tx.merchant_name || null,
             catId, plaidCat, tx.date, tx.pending || false]
          );
          plaidTx = ptRows[0] || null;
        }

        // Auto-confirm new non-pending transactions directly into expenses.
        // is_impulse stays NULL so the check-in flow classifies them later.
        if (plaidTx && !tx.pending) {
          try {
            const expDate = String(tx.date).slice(0, 10);
            let expenseId = null;
            if (tx.transaction_id) {
              const { rows: dup } = await pool.query(
                'SELECT id FROM expenses WHERE plaid_transaction_id = $1 LIMIT 1',
                [tx.transaction_id]
              );
              expenseId = dup[0]?.id || null;
            }
            if (!expenseId) {
              const cols = ['user_id', 'amount', 'description', 'expense_date', 'source', 'plaid_transaction_id'];
              const vals = [item.user_id, tx.amount, tx.merchant_name || tx.name || 'Unknown', expDate, 'plaid', tx.transaction_id];
              if (catId) { cols.push('category_id'); vals.push(catId); }
              const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
              const { rows: expRows } = await pool.query(
                `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING id`, vals
              );
              expenseId = expRows[0]?.id || null;
            }
            if (expenseId) {
              await pool.query(
                'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
                [expenseId, plaidTx.id]
              );
            }
          } catch (e) {
            console.warn(`[plaid-sync] Confirm error tx ${tx.transaction_id}:`, e.message);
          }
          added++;
        }
      } catch (e) {
        console.warn(`[plaid-sync] Insert error tx ${tx.transaction_id}:`, e.message);
      }
    }

    for (const removedTx of removed) {
      await pool.query(
        'DELETE FROM plaid_transactions WHERE transaction_id = $1 AND user_id = $2 AND is_confirmed = false',
        [removedTx.transaction_id, item.user_id]
      );
    }

    cursor = next_cursor;
    hasMore = has_more;
    if (!hasMore) break;
  }

  // Update cursor
  await pool.query(
    'UPDATE plaid_items SET cursor = $1, last_synced_at = NOW() WHERE id = $2',
    [cursor, item.id]
  );

  return added;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[plaid-sync] Starting daily Plaid sync...');

  const result = await pool.query(
    'SELECT id, user_id, access_token, cursor, last_synced_at FROM plaid_items'
  );
  const items = result.rows;
  console.log(`[plaid-sync] Found ${items.length} items to check`);

  if (items.length === 0) {
    await pool.end();
    return;
  }

  const { insertEvent } = require('../db/events');
  let totalSynced = 0;
  let totalAdded = 0;

  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    const promises = chunk.map(async (item) => {
      try {
        const added = await syncOneItem(item);
        await insertEvent(pool, {
          userId: item.user_id,
          eventType: 'transactions.synced',
          payload: { itemId: item.id, added, source: 'plaid_sync_cron' }
        }).catch(e => console.warn('[plaid-sync] Event log error:', e.message));
        totalAdded += added;
        totalSynced++;
        console.log(`[plaid-sync] Item ${item.id} (user ${item.user_id}): +${added} transactions`);
      } catch (e) {
        console.error(`[plaid-sync] Error syncing item ${item.id}:`, e.message);
      }
    });
    await Promise.all(promises);
  }

  console.log(`[plaid-sync] Done — synced ${totalSynced} items, ${totalAdded} new transactions`);
  await pool.end();
}

main().catch(err => {
  console.error('[plaid-sync] Fatal error:', err.message);
  pool.end().then(() => process.exit(1)).catch(() => process.exit(1));
});