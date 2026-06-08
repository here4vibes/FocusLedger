'use strict';
/**
 * Plaid Daily Sync Scheduler
 *
 * Runs once per hour (at :00). For each Pro user with a connected plaid_item:
 *   1. Checks if the item was last synced more than 23 hours ago.
 *   2. If so, calls transactionsSync (cursor-based) to pull new transactions.
 *   3. Updates the cursor + last_synced_at on the item.
 *
 * Uses setInterval polling (same pattern as morningNudge.js / emailCron.js).
 * Idempotent — ON CONFLICT DO NOTHING prevents duplicate transactions.
 * All DB operations go through db/plaid.js (no raw SQL in this file).
 *
 * WHY NOT ON-LOGIN: on-login sync works for active users but misses inactive
 * accounts. A background sync ensures transaction data stays fresh even when
 * users don't log in daily — important for ADHD users who need the app to
 * do the work for them.
 */

const crypto = require('crypto');
const plaidDb = require('./db/plaid');
const { insertEvent } = require('./db/events');

// ── Encryption helpers (same key derivation as routes/plaid.js) ───────────────
function decryptPlaidToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const key = Buffer.from(
      crypto.createHash('sha256')
        .update(process.env.PLAID_ENCRYPTION_KEY || process.env.JWT_SECRET || 'focusledger-plaid-enc')
        .digest('hex'),
      'hex'
    ).subarray(0, 32);
    const data = Buffer.from(ciphertext, 'base64');
    if (data.length < 29) return ciphertext; // too short → treat as plaintext legacy
    const iv  = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const enc = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext; // unencrypted legacy token — return as-is
  }
}

// ── Plaid client (lazy, same as routes/plaid.js) ───────────────────────────────
function getPlaidClient() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) return null;
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
    return new PlaidApi(config);
  } catch (e) {
    console.error('[PlaidDailySync] Failed to initialize Plaid client:', e.message);
    return null;
  }
}

// ── Minimal category classifier (mirrors routes/plaid.js) ────────────────────
const PLAID_CATEGORY_MAP = {
  GROCERIES: 'Groceries', FOOD_AND_DRINK: 'Food & Dining', RESTAURANTS: 'Food & Dining',
  TRANSPORTATION: 'Transport', TRAVEL: 'Transport',
  GENERAL_MERCHANDISE: 'Shopping', CLOTHING_AND_ACCESSORIES: 'Shopping',
  UTILITIES: 'Bills & Utilities', BILL_PAYMENTS: 'Bills & Utilities',
  RENT_AND_UTILITIES: 'Bills & Utilities', LOAN_PAYMENTS: 'Bills & Utilities',
  ENTERTAINMENT: 'Entertainment', RECREATION: 'Entertainment',
  MEDICAL: 'Health', PERSONAL_CARE: 'Health', FITNESS: 'Health',
};

function classifyToDbCategory(tx, categoriesByName) {
  let categoryName = 'Other';
  if (tx.personal_finance_category) {
    const primary = tx.personal_finance_category.primary;
    const detailed = tx.personal_finance_category.detailed || '';
    if (primary === 'FOOD_AND_DRINK' &&
        (detailed.includes('GROCERY') || detailed.includes('SUPERMARKET'))) {
      categoryName = 'Groceries';
    } else if (PLAID_CATEGORY_MAP[primary]) {
      categoryName = PLAID_CATEGORY_MAP[primary];
    }
  } else if (tx.category && tx.category.length > 0) {
    const catStr = tx.category.join(' ').toLowerCase();
    if (catStr.includes('grocer') || catStr.includes('supermarket')) categoryName = 'Groceries';
    else if (catStr.includes('food') || catStr.includes('restaurant')) categoryName = 'Food & Dining';
    else if (catStr.includes('transport') || catStr.includes('travel')) categoryName = 'Transport';
    else if (catStr.includes('shop')) categoryName = 'Shopping';
    else if (catStr.includes('utility') || catStr.includes('utilities')) categoryName = 'Bills & Utilities';
    else if (catStr.includes('health') || catStr.includes('medical')) categoryName = 'Health';
    else if (catStr.includes('entertainment')) categoryName = 'Entertainment';
  }
  const cat = categoriesByName[categoryName.toLowerCase()] || categoriesByName['other'];
  return cat ? cat.id : null;
}

// ── Sync one item (uses db/plaid.js for all DB writes) ───────────────────────
async function syncOneItem(pool, plaid, item) {
  const accessToken = decryptPlaidToken(item.access_token);
  let cursor = item.cursor || null;
  let hasMore = true;
  let added = 0;

  const accountMap = await plaidDb.getAccountMap(pool, item.id);
  const categoriesByName = await plaidDb.getCategoriesMap(pool);

  while (hasMore) {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 100,
    });
    const { added: newTxs, removed, next_cursor, has_more } = response.data;

    for (const tx of newTxs) {
      if (tx.amount <= 0) continue; // skip credits/refunds
      const plaidAccountId = accountMap[tx.account_id];
      if (!plaidAccountId) continue;

      const categoryId = classifyToDbCategory(tx, categoriesByName);
      const description = tx.merchant_name || tx.name || 'Unknown';
      const plaidCategoryStr = tx.personal_finance_category
        ? `${tx.personal_finance_category.primary}/${tx.personal_finance_category.detailed}`
        : (tx.category ? tx.category.join(' > ') : null);

      try {
        const wasInserted = await plaidDb.insertTransaction(pool, {
          plaidAccountId,
          userId: item.user_id,
          transactionId: tx.transaction_id,
          amount: tx.amount,
          description,
          merchantName: tx.merchant_name || null,
          categoryId,
          plaidCategory: plaidCategoryStr,
          transactionDate: tx.date,
          isPending: tx.pending || false,
        });
        if (wasInserted) added++;
      } catch (e) {
        console.error('[PlaidDailySync] Insert error tx', tx.transaction_id, ':', e.message);
      }
    }

    for (const removedTx of removed) {
      await plaidDb.removeTransaction(pool, removedTx.transaction_id, item.user_id);
    }

    cursor = next_cursor;
    hasMore = has_more;
    if (!hasMore) break;
  }

  await plaidDb.updateItemCursor(pool, item.id, cursor);

  // Emit transactions.synced event
  insertEvent(pool, { userId: item.user_id, eventType: 'transactions.synced', payload: { itemId: item.id, added, source: 'plaid_daily_sync' } }).catch(e =>
    console.warn('[PlaidDailySync] Event log error:', e.message)
  );

  return added;
}

// ── Main sync job ─────────────────────────────────────────────────────────────
const STALE_THRESHOLD_MS = 23 * 60 * 60 * 1000; // 23 hours

async function runDailySync(pool) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) return;

  const plaid = getPlaidClient();
  if (!plaid) return;

  let items;
  try {
    items = await plaidDb.getAllItems(pool);
  } catch (e) {
    console.error('[PlaidDailySync] Failed to fetch items:', e.message);
    return;
  }

  const now = Date.now();
  let synced = 0;
  let totalAdded = 0;

  for (const item of items) {
    const lastSync = item.last_synced_at ? new Date(item.last_synced_at).getTime() : 0;
    if (now - lastSync < STALE_THRESHOLD_MS) continue; // synced recently

    try {
      const added = await syncOneItem(pool, plaid, item);
      totalAdded += added;
      synced++;
      console.log(`[PlaidDailySync] Item ${item.id} (user ${item.user_id}): +${added} transactions`);
    } catch (e) {
      console.error(`[PlaidDailySync] Error syncing item ${item.id}:`, e.message);
    }
  }

  if (synced > 0) {
    console.log(`[PlaidDailySync] Done: synced ${synced} items, ${totalAdded} new transactions`);
  }
}

// ── Scheduler — checks every hour ────────────────────────────────────────────
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function schedulePlaidDailySync(pool) {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    console.log('[PlaidDailySync] PLAID_CLIENT_ID or PLAID_SECRET not set — sync disabled');
    return;
  }

  // Run once at startup (offset 5s to let DB settle after boot)
  setTimeout(() => {
    runDailySync(pool).catch(e =>
      console.error('[PlaidDailySync] Startup sync error:', e.message)
    );
  }, 5000);

  // Then every hour
  setInterval(() => {
    runDailySync(pool).catch(e =>
      console.error('[PlaidDailySync] Interval sync error:', e.message)
    );
  }, CHECK_INTERVAL_MS);

  console.log('[PlaidDailySync] Scheduled — runs every hour, syncs items stale > 23h');
}

async function syncItemByPlaidId(pool, plaidItemId) {
  const plaidDb = require('./db/plaid');
  const item = await plaidDb.getItemByPlaidItemId(pool, plaidItemId);
  if (!item) return { userId: null, added: 0 };
  const plaid = getPlaidClient();
  if (!plaid) return { userId: item.user_id, added: 0 };
  const added = await syncOneItem(pool, plaid, item);
  return { userId: item.user_id, added };
}

module.exports = { schedulePlaidDailySync, syncItemByPlaidId };
