'use strict';
/**
 * db/plaid.js — Named query functions for all Plaid-related tables.
 *
 * Tables owned: plaid_items, plaid_accounts, plaid_transactions, bill_preferences
 *
 * Rules:
 *  - No raw SQL outside this file (all Plaid DB queries live here)
 *  - All functions accept `pool` as first argument (no module-level pool state)
 *  - Returns raw pg result rows — callers decide how to handle
 */

// ── plaid_items ───────────────────────────────────────────────────────────────

/**
 * Fetch all plaid_items for a user, with their linked accounts.
 * @param {object} pool  - pg Pool
 * @param {number} userId
 * @returns {Promise<object[]>} rows with accounts JSON-aggregated
 */
async function getItemsForUser(pool, userId) {
  const result = await pool.query(
    `SELECT pi.id, pi.institution_name, pi.institution_id, pi.item_id,
            pi.last_synced_at, pi.created_at,
            json_agg(json_build_object(
              'id', pa.id,
              'name', pa.name,
              'type', pa.type,
              'subtype', pa.subtype,
              'mask', pa.mask
            )) FILTER (WHERE pa.id IS NOT NULL) AS accounts
     FROM plaid_items pi
     LEFT JOIN plaid_accounts pa ON pa.plaid_item_id = pi.id
     WHERE pi.user_id = $1
     GROUP BY pi.id
     ORDER BY pi.created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Fetch a single plaid_item by id, scoped to user.
 * @param {object} pool
 * @param {number} itemId
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getItemById(pool, itemId, userId) {
  const result = await pool.query(
    'SELECT * FROM plaid_items WHERE id = $1 AND user_id = $2',
    [itemId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Fetch all plaid_items for a user (raw rows, used by sync cron).
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function getRawItemsForUser(pool, userId) {
  const result = await pool.query(
    'SELECT * FROM plaid_items WHERE user_id = $1',
    [userId]
  );
  return result.rows;
}

/**
 * Fetch all plaid_items across all users (used by daily sync cron).
 * Returns items with their user_id for cron iteration.
 * @param {object} pool
 * @returns {Promise<object[]>}
 */
async function getAllItems(pool) {
  const result = await pool.query(
    `SELECT pi.*, u.subscription_status
     FROM plaid_items pi
     JOIN users u ON u.id = pi.user_id
     WHERE u.subscription_status IN ('pro', 'pro_override')
     ORDER BY pi.last_synced_at ASC NULLS FIRST`
  );
  return result.rows;
}

/**
 * Insert a new plaid_item. access_token must already be encrypted by caller.
 * @param {object} pool
 * @param {number} userId
 * @param {string} encryptedAccessToken
 * @param {string} itemId  - Plaid's item_id
 * @param {string} institutionName
 * @param {string|null} institutionId
 * @returns {Promise<object>} inserted row
 */
async function insertItem(pool, userId, encryptedAccessToken, itemId, institutionName, institutionId) {
  const result = await pool.query(
    `INSERT INTO plaid_items (user_id, access_token, item_id, institution_name, institution_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, encryptedAccessToken, itemId, institutionName || 'Unknown Bank', institutionId || null]
  );
  return result.rows[0];
}

/**
 * Update the sync cursor and last_synced_at for a plaid_item.
 * @param {object} pool
 * @param {number} itemId
 * @param {string|null} cursor
 * @returns {Promise<void>}
 */
async function updateItemCursor(pool, itemId, cursor) {
  await pool.query(
    'UPDATE plaid_items SET cursor = $1, last_synced_at = NOW() WHERE id = $2',
    [cursor, itemId]
  );
}

/**
 * Delete a plaid_item (cascades to plaid_accounts + plaid_transactions).
 * @param {object} pool
 * @param {number} itemId
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function deleteItem(pool, itemId, userId) {
  await pool.query(
    'DELETE FROM plaid_items WHERE id = $1 AND user_id = $2',
    [itemId, userId]
  );
}

// ── plaid_accounts ────────────────────────────────────────────────────────────

/**
 * Upsert a plaid_account from a Plaid accounts.get response account object.
 * @param {object} pool
 * @param {number} plaidItemId
 * @param {number} userId
 * @param {object} acc  - Plaid account object
 * @returns {Promise<object>} upserted row
 */
async function upsertAccount(pool, plaidItemId, userId, acc) {
  const result = await pool.query(
    `INSERT INTO plaid_accounts
       (plaid_item_id, user_id, account_id, name, official_name, type, subtype, mask)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id) DO UPDATE
       SET name = EXCLUDED.name, mask = EXCLUDED.mask
     RETURNING *`,
    [plaidItemId, userId, acc.account_id, acc.name,
     acc.official_name || null, acc.type, acc.subtype || null, acc.mask || null]
  );
  return result.rows[0];
}

/**
 * Return a map of Plaid account_id → db id for a given plaid_item.
 * Used by syncTransactions to link transactions to the correct account row.
 * @param {object} pool
 * @param {number} plaidItemId
 * @returns {Promise<Record<string, number>>}
 */
async function getAccountMap(pool, plaidItemId) {
  const result = await pool.query(
    'SELECT id, account_id FROM plaid_accounts WHERE plaid_item_id = $1',
    [plaidItemId]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.account_id] = row.id;
  }
  return map;
}

// ── plaid_transactions ────────────────────────────────────────────────────────

/**
 * Count unconfirmed (non-pending) transactions for a user.
 * Used by /status endpoint to surface "N to review" badge.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<number>}
 */
async function countPendingReview(pool, userId) {
  const result = await pool.query(
    'SELECT COUNT(*) AS count FROM plaid_transactions WHERE user_id = $1 AND is_confirmed = false AND is_pending = false',
    [userId]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Fetch up to 50 unconfirmed transactions for user review.
 * Joins categories + account info for display.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function getPendingTransactions(pool, userId) {
  const result = await pool.query(
    `SELECT pt.id, pt.transaction_id, pt.amount, pt.description, pt.merchant_name,
            pt.plaid_category, pt.transaction_date, pt.is_pending,
            pt.category_id,
            c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            pa.name AS account_name, pa.mask AS account_mask
     FROM plaid_transactions pt
     LEFT JOIN categories c ON c.id = pt.category_id
     LEFT JOIN plaid_accounts pa ON pa.id = pt.plaid_account_id
     WHERE pt.user_id = $1 AND pt.is_confirmed = false AND pt.is_pending = false
     ORDER BY pt.transaction_date DESC, pt.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return result.rows;
}

/**
 * Insert a transaction from Plaid sync. Silently ignores duplicates (ON CONFLICT DO NOTHING).
 * @param {object} pool
 * @param {object} params
 * @returns {Promise<boolean>} true if inserted, false if duplicate
 */
async function insertTransaction(pool, params) {
  const {
    plaidAccountId, userId, transactionId, amount, description,
    merchantName, categoryId, plaidCategory, transactionDate, isPending
  } = params;

  const result = await pool.query(
    `INSERT INTO plaid_transactions
       (plaid_account_id, user_id, transaction_id, amount, description, merchant_name,
        category_id, plaid_category, transaction_date, is_pending)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (transaction_id) DO NOTHING
     RETURNING id`,
    [plaidAccountId, userId, transactionId, amount, description,
     merchantName || null, categoryId, plaidCategory, transactionDate, isPending || false]
  );
  return result.rows.length > 0;
}

/**
 * Remove unconfirmed transactions by Plaid transaction_id (for removed tx from sync).
 * @param {object} pool
 * @param {string} transactionId
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function removeTransaction(pool, transactionId, userId) {
  await pool.query(
    'DELETE FROM plaid_transactions WHERE transaction_id = $1 AND user_id = $2 AND is_confirmed = false',
    [transactionId, userId]
  );
}

/**
 * Fetch a single unconfirmed plaid_transaction with its category name.
 * @param {object} pool
 * @param {number} plaidTxId  - db id (not Plaid transaction_id)
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getUnconfirmedTransaction(pool, plaidTxId, userId) {
  const result = await pool.query(
    `SELECT pt.*, c.name AS category_name
     FROM plaid_transactions pt
     LEFT JOIN categories c ON c.id = pt.category_id
     WHERE pt.id = $1 AND pt.user_id = $2 AND pt.is_confirmed = false`,
    [plaidTxId, userId]
  );
  return result.rows[0] || null;
}

/**
 * Mark a transaction as confirmed, linking it to the created expense.
 * @param {object} pool
 * @param {number} plaidTxId
 * @param {number} expenseId
 * @returns {Promise<void>}
 */
async function confirmTransaction(pool, plaidTxId, expenseId) {
  await pool.query(
    `UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [expenseId, plaidTxId]
  );
}

/**
 * Dismiss (mark confirmed without creating expense) a transaction.
 * @param {object} pool
 * @param {number} plaidTxId
 * @param {number} userId
 * @returns {Promise<boolean>} true if found and dismissed
 */
async function dismissTransaction(pool, plaidTxId, userId) {
  const result = await pool.query(
    `UPDATE plaid_transactions SET is_confirmed = true, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [plaidTxId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Update the category_id of an unconfirmed transaction.
 * @param {object} pool
 * @param {number} plaidTxId
 * @param {number} categoryId
 * @param {number} userId
 * @returns {Promise<boolean>} true if updated
 */
async function recategorizeTransaction(pool, plaidTxId, categoryId, userId) {
  const result = await pool.query(
    `UPDATE plaid_transactions SET category_id = $1, updated_at = NOW()
     WHERE id = $2 AND user_id = $3
     RETURNING id`,
    [categoryId, plaidTxId, userId]
  );
  return result.rows.length > 0;
}

// ── bill_preferences ──────────────────────────────────────────────────────────

/**
 * Fetch all bill preferences (merchant → auto-task config) for a user.
 * Includes active task count for display.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function getBillPreferences(pool, userId) {
  const result = await pool.query(
    `SELECT bp.merchant_key, bp.merchant_display_name, bp.bill_type, bp.is_disabled,
            COUNT(t.id) FILTER (WHERE t.is_completed = false) AS active_tasks,
            MAX(t.created_at) AS last_task_created_at
     FROM bill_preferences bp
     LEFT JOIN tasks t ON t.bill_merchant_key = bp.merchant_key AND t.user_id = bp.user_id
     WHERE bp.user_id = $1
     GROUP BY bp.merchant_key, bp.merchant_display_name, bp.bill_type, bp.is_disabled
     ORDER BY bp.merchant_display_name`,
    [userId]
  );
  return result.rows;
}

/**
 * Get disabled merchant keys for a user (used during bill detection).
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<Set<string>>}
 */
async function getDisabledMerchantKeys(pool, userId) {
  const result = await pool.query(
    'SELECT merchant_key FROM bill_preferences WHERE user_id = $1 AND is_disabled = true',
    [userId]
  );
  return new Set(result.rows.map(r => r.merchant_key));
}

/**
 * Upsert a bill preference (sets is_disabled = true/false).
 * @param {object} pool
 * @param {number} userId
 * @param {string} merchantKey
 * @param {boolean} isDisabled
 * @returns {Promise<void>}
 */
async function upsertBillPreference(pool, userId, merchantKey, isDisabled) {
  await pool.query(
    `INSERT INTO bill_preferences (user_id, merchant_key, is_disabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, merchant_key) DO UPDATE SET is_disabled = $3, updated_at = NOW()`,
    [userId, merchantKey, isDisabled]
  );
}

/**
 * Upsert bill preference with full metadata (called during auto-task creation).
 * @param {object} pool
 * @param {number} userId
 * @param {string} merchantKey
 * @param {string} merchantDisplayName
 * @param {string} billType
 * @returns {Promise<void>}
 */
async function trackBillMerchant(pool, userId, merchantKey, merchantDisplayName, billType) {
  await pool.query(
    `INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bill_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, merchant_key) DO UPDATE
       SET merchant_display_name = EXCLUDED.merchant_display_name,
           bill_type = EXCLUDED.bill_type,
           updated_at = NOW()`,
    [userId, merchantKey, merchantDisplayName, billType]
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch categories as a map { lowercase_name → row }.
 * Used by sync logic that needs to resolve category names to IDs.
 * @param {object} pool
 * @returns {Promise<Record<string, object>>}
 */
async function getCategoriesMap(pool) {
  const result = await pool.query('SELECT id, name FROM categories');
  const map = {};
  for (const cat of result.rows) {
    map[cat.name.toLowerCase()] = cat;
  }
  return map;
}

async function getItemByPlaidItemId(pool, plaidItemId) {
  const result = await pool.query(
    'SELECT * FROM plaid_items WHERE item_id = $1',
    [plaidItemId]
  );
  return result.rows[0] || null;
}

module.exports = {
  // plaid_items
  getItemsForUser,
  getItemById,
  getItemByPlaidItemId,
  getRawItemsForUser,
  getAllItems,
  insertItem,
  updateItemCursor,
  deleteItem,
  // plaid_accounts
  upsertAccount,
  getAccountMap,
  // plaid_transactions
  countPendingReview,
  getPendingTransactions,
  insertTransaction,
  removeTransaction,
  getUnconfirmedTransaction,
  confirmTransaction,
  dismissTransaction,
  recategorizeTransaction,
  // bill_preferences
  getBillPreferences,
  getDisabledMerchantKeys,
  upsertBillPreference,
  trackBillMerchant,
  // helpers
  getCategoriesMap,
};
