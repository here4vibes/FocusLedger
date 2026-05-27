'use strict';
/**
 * db/transactions.js — Named query functions for the transactions table.
 *
 * Tables owned: transactions, plaid_tokens, spending_sessions, transaction_classifications
 *
 * Does NOT own: plaid_items, plaid_accounts, plaid_transactions (see db/plaid.js),
 *               expenses table (see db/expenses.js).
 */

const crypto = require('crypto');

// ── Token encryption (AES-256-GCM) ───────────────────────────────────────────

const _encKey = Buffer.from(
  crypto.createHash('sha256')
    .update(process.env.PLAID_ENCRYPTION_KEY || process.env.JWT_SECRET || 'focusledger-plaid-enc')
    .digest('hex'),
  'hex'
).subarray(0, 32);

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(ciphertext) {
  if (!ciphertext) return null;
  try {
    const data = Buffer.from(ciphertext, 'base64');
    if (data.length < 29) return ciphertext;
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

// ── plaid_tokens ──────────────────────────────────────────────────────────────

/**
 * Upsert a Plaid access token for a user. One active token per user.
 * @param {object} pool
 * @param {object} opts
 * @returns {Promise<object>} upserted row
 */
async function upsertPlaidToken(pool, opts) {
  const { userId, encryptedAccessToken, itemId, institutionName, institutionId } = opts;
  const result = await pool.query(
    `INSERT INTO plaid_tokens (user_id, access_token, item_id, institution_name, institution_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token     = EXCLUDED.access_token,
       item_id          = EXCLUDED.item_id,
       institution_name = EXCLUDED.institution_name,
       institution_id   = EXCLUDED.institution_id,
       updated_at       = NOW()
     RETURNING *`,
    [userId, encryptedAccessToken, itemId || null,
     institutionName || 'Unknown Bank', institutionId || null]
  );
  return result.rows[0];
}

/**
 * Get the plaid_token row for a user.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getPlaidToken(pool, userId) {
  const result = await pool.query(
    'SELECT * FROM plaid_tokens WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Delete the plaid_token for a user (disconnect).
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<void>}
 */
async function deletePlaidToken(pool, userId) {
  await pool.query('DELETE FROM plaid_tokens WHERE user_id = $1', [userId]);
}

/**
 * Fetch all plaid_tokens for cron iteration (Pro users only).
 * @param {object} pool
 * @returns {Promise<object[]>}
 */
async function getAllPlaidTokens(pool) {
  const result = await pool.query(
    `SELECT pt.*, u.subscription_status
     FROM plaid_tokens pt
     JOIN users u ON u.id = pt.user_id
     WHERE u.subscription_status IN ('pro', 'pro_override')
     ORDER BY pt.updated_at ASC`
  );
  return result.rows;
}

// ── transactions (normalized ledger) ─────────────────────────────────────────

/**
 * Upsert a transaction. Deduplicates on plaid_transaction_id.
 * @param {object} pool
 * @param {object} params — supports both snake_case (PlaidService) and camelCase (TransactionService) keys
 * @returns {Promise<object>} upserted row
 */
async function upsertTransaction(pool, params) {
  // Normalize: support { plaid_transaction_id, user_id } (snake) and
  // { plaidTransactionId, userId } (camel) callers
  const plaidTransactionId = params.plaid_transaction_id || params.plaidTransactionId;
  const userId             = params.user_id             || params.userId;
  const merchantName        = params.merchant_name        || params.merchantName;
  const amount             = params.amount;
  const category           = params.category;
  const categoryIcon       = params.category_icon         || params.categoryIcon;
  const date               = params.date;
  const pending            = params.pending;
  const logoUrl           = params.logo_url              || params.logoUrl;

  const result = await pool.query(
    `INSERT INTO transactions
       (plaid_transaction_id, user_id, merchant_name, amount, category,
        category_icon, date, pending, logo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL
     DO UPDATE SET
       merchant_name = EXCLUDED.merchant_name,
       amount        = EXCLUDED.amount,
       category      = EXCLUDED.category
     RETURNING *`,
    [
      plaidTransactionId,
      userId,
      merchantName || null,
      amount,
      category || null,
      categoryIcon || null,
      date,
      pending || false,
      logoUrl || null,
    ]
  );
  return result.rows[0];
}

/**
 * Alias for getTransactionById — used by TransactionService.
 */
async function getById(pool, id, userId) {
  return getTransactionById(pool, id, userId);
}

/**
 * List transactions with optional date range + category filter + classification filter + search + pagination.
 * Classification filter: LEFT JOIN transaction_classifications to allow filtering.
 * @param {object} pool
 * @param {{ userId: number, from?: string, to?: string, category?: string, classification?: string, search?: string, limit?: number, offset?: number }} opts
 * @returns {{ transactions: object[], total: number, has_more: boolean }}
 */
async function listTransactions(pool, opts) {
  const { userId, from, to, category, classification, search, limit = 20, offset = 0 } = opts;
  const params = [userId];
  let where = 'WHERE t.user_id = $1';
  let joinClass = '';

  if (from) {
    params.push(from);
    where += ` AND t.date >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND t.date <= $${params.length}`;
  }
  if (category) {
    params.push(category);
    where += ` AND LOWER(t.category) = LOWER($${params.length})`;
  }
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    where += ` AND LOWER(t.merchant_name) LIKE LOWER($${params.length})`;
  }
  if (classification && classification !== 'all') {
    joinClass = `LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id AND tc.user_id = $1`;
    if (classification === 'planned') {
      where += ` AND tc.classification = 'planned'`;
    } else if (classification === 'impulse') {
      where += ` AND tc.classification = 'impulse'`;
    }
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) AS total FROM transactions t ${joinClass} ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const selectCols = joinClass
    ? `t.id, t.plaid_transaction_id, t.user_id, t.merchant_name, t.amount,
            t.category, t.category_icon, t.date, t.pending, t.logo_url, t.created_at,
            tc.classification, tc.swiped_at`
    : `t.id, t.plaid_transaction_id, t.user_id, t.merchant_name, t.amount,
            t.category, t.category_icon, t.date, t.pending, t.logo_url, t.created_at`;

  const queryParams = [...params, limit, offset];
  const result = await pool.query(
    `SELECT ${selectCols}
     FROM transactions t ${joinClass}
     ${where}
     ORDER BY t.date DESC, t.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    queryParams
  );

  return {
    transactions: result.rows,
    total,
    has_more: offset + result.rows.length < total,
  };
}

/**
 * Fetch a single transaction by id, scoped to user.
 * @param {object} pool
 * @param {string} id  — UUID
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getTransactionById(pool, id, userId) {
  const result = await pool.query(
    `SELECT id, plaid_transaction_id, user_id, merchant_name, amount,
            category, category_icon, date, pending, logo_url, created_at
     FROM transactions WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

/**
 * Fetch today's transactions for a user.
 * @param {object} pool
 * @param {number} userId
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 * @returns {Promise<object[]>}
 */
async function getTodayTransactions(pool, userId, localDate) {
  const today = localDate || new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT id, plaid_transaction_id, user_id, merchant_name, amount,
            category, category_icon, date, pending, logo_url, created_at
     FROM transactions WHERE user_id = $1 AND date = $2
     ORDER BY created_at DESC`,
    [userId, today]
  );
  return result.rows;
}

/**
 * Aggregate spending for a date range: total + by-category + by-day.
 * @param {object} pool
 * @param {number} userId
 * @param {string|null} from — YYYY-MM-DD
 * @param {string|null} to   — YYYY-MM-DD
 * @returns {{ total_spend: number, by_category: object[], by_day: object[] }}
 */
async function getAggregate(pool, userId, from, to) {
  const params = [userId];
  let where = 'WHERE user_id = $1';

  if (from) {
    params.push(from);
    where += ` AND date >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    where += ` AND date <= $${params.length}`;
  }

  const [totalResult, byCategory, byDay] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total_spend FROM transactions ${where}`, params),
    pool.query(
      `SELECT COALESCE(category, 'Other') AS category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM transactions ${where} GROUP BY category ORDER BY total DESC`,
      params
    ),
    pool.query(
      `SELECT date, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM transactions ${where} GROUP BY date ORDER BY date ASC`,
      params
    ),
  ]);

  return {
    total_spend: parseInt(totalResult.rows[0].total_spend, 10),
    by_category: byCategory.rows,
    by_day: byDay.rows,
  };
}

// ── Classification queries (added by ClassificationService) ──────────────────

/**
 * Fetch unclassified transactions for a user on a given date.
 * "Unclassified" = not present in transaction_classifications for this user.
 * Sorted by amount desc so biggest transactions appear first.
 */
async function getUnclassifiedByDate(pool, userId, date) {
  const result = await pool.query(
    `SELECT t.id, t.merchant_name, t.amount, t.category, t.category_icon,
            t.date, t.pending, t.logo_url, t.created_at
     FROM transactions t
     WHERE t.user_id = $1 AND t.date = $2 AND t.pending = false
       AND NOT EXISTS (
         SELECT 1 FROM transaction_classifications tc
          WHERE tc.transaction_id = t.id AND tc.user_id = $1
       )
     ORDER BY t.amount DESC`,
    [userId, date]
  );
  return result.rows;
}

/**
 * Fetch all transactions for a user on a date (classified + unclassified).
 */
async function getByDate(pool, userId, date) {
  const result = await pool.query(
    `SELECT t.id, t.merchant_name, t.amount, t.category, t.category_icon,
            t.date, t.pending, t.logo_url, tc.classification, tc.swiped_at
     FROM transactions t
     LEFT JOIN transaction_classifications tc ON tc.transaction_id = t.id AND tc.user_id = $1
     WHERE t.user_id = $1 AND t.date = $2 AND t.pending = false
     ORDER BY t.amount DESC`,
    [userId, date]
  );
  return result.rows;
}

/**
 * Count unclassified transactions for a user on a given date.
 * Used to populate session.transaction_count on session start.
 */
async function countUnclassified(pool, userId, date) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM transactions t
     WHERE t.user_id = $1 AND t.date = $2 AND t.pending = false
       AND NOT EXISTS (
         SELECT 1 FROM transaction_classifications tc
          WHERE tc.transaction_id = t.id AND tc.user_id = $1
       )`,
    [userId, date]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Fetch a single transaction with its classification (if any).
 * @param {object} pool
 * @param {string} id  — UUID
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
async function getTransactionWithClassification(pool, id, userId) {
  const result = await pool.query(
    `SELECT t.id, t.plaid_transaction_id, t.user_id, t.merchant_name,
            t.amount, t.category, t.category_icon, t.date, t.pending,
            t.logo_url, t.created_at,
            tc.classification, tc.swiped_at
     FROM transactions t
     LEFT JOIN transaction_classifications tc
       ON tc.transaction_id = t.id AND tc.user_id = $2
     WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId]
  );
  return result.rows[0] || null;
}

/**
 * Update or insert a classification for a transaction.
 * @param {object} pool
 * @param {string} transactionId  — UUID
 * @param {number} userId
 * @param {string} classification  — 'planned' | 'impulse'
 * @returns {Promise<object>}
 */
async function updateClassification(pool, transactionId, userId, classification) {
  const result = await pool.query(
    `INSERT INTO transaction_classifications (transaction_id, user_id, classification, swiped_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (transaction_id, user_id) WHERE transaction_id IS NOT NULL
     DO UPDATE SET classification = EXCLUDED.classification,
                   swiped_at = EXCLUDED.swiped_at
     RETURNING *`,
    [transactionId, userId, classification]
  );
  return result.rows[0];
}

/**
 * Return classification counts for today's transactions: impulse, planned, unreviewed.
 * @param {object} pool
 * @param {number} userId
 * @param {string} date — YYYY-MM-DD
 * @returns {{ impulse: number, planned: number, unreviewed: number, total: number }}
 */
async function getTodayClassificationCounts(pool, userId, date) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE tc.classification = 'impulse') AS impulse,
       COUNT(*) FILTER (WHERE tc.classification = 'planned') AS planned,
       COUNT(*) FILTER (WHERE tc.classification IS NULL)     AS unreviewed,
       COUNT(*)                                              AS total
     FROM transactions t
     LEFT JOIN transaction_classifications tc
       ON tc.transaction_id = t.id AND tc.user_id = $1
     WHERE t.user_id = $1 AND t.date = $2 AND t.pending = false`,
    [userId, date]
  );
  const row = result.rows[0] || {};
  return {
    impulse:    parseInt(row.impulse,    10) || 0,
    planned:    parseInt(row.planned,    10) || 0,
    unreviewed: parseInt(row.unreviewed, 10) || 0,
    total:      parseInt(row.total,      10) || 0,
  };
}

module.exports = {
  // plaid_tokens
  upsertPlaidToken,
  getPlaidToken,
  deletePlaidToken,
  getAllPlaidTokens,
  // transactions (normalized ledger)
  upsertTransaction,
  listTransactions,
  getTransactionById,
  getTodayTransactions,
  getAggregate,
  getById,  // alias for getTransactionById — used by TransactionService
  // classification queries
  getUnclassifiedByDate,
  getByDate,
  countUnclassified,
  // classification CRUD
  getTransactionWithClassification,
  updateClassification,
  getTodayClassificationCounts,
};