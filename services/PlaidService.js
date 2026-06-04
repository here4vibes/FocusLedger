'use strict';
/**
 * services/PlaidService.js — Plaid API integration + token/transaction management.
 *
 * Owns: Plaid API calls, access token lifecycle, transaction normalization.
 * Does NOT own: DB queries (delegates to db/transactions.js),
 *               token encryption helpers (inline here, shared with routes/plaid.js),
 *               scheduling (see polsia.toml [[crons]]).
 */

const crypto = require('crypto');

// ── Token encryption (AES-256-GCM, same scheme as routes/plaid.js) ─────────────

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

// ── Category → icon mapping (FocusLedger's canonical emoji map) ──────────────

const CATEGORY_ICON_MAP = {
  'Food & Dining':       '🍕',
  'Groceries':            '🛒',
  'Transport':            '🚗',
  'Shopping':            '🛍️',
  'Bills & Utilities':   '📄',
  'Entertainment':        '🎮',
  'Health':              '🏥',
  'Housing':             '🏠',
  'Subscriptions':        '🔄',
  'Other':               '📦',
};

function getCategoryIcon(category) {
  return CATEGORY_ICON_MAP[category] || '📦';
}

// ── Plaid client factory ──────────────────────────────────────────────────────

function getPlaidClient() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return null;
  }
  try {
    const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
    const config = new Configuration({
      basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });
    return new PlaidApi(config);
  } catch (e) {
    console.error('[PlaidService] Failed to initialize Plaid client:', e.message);
    return null;
  }
}

// ── Category normalization ─────────────────────────────────────────────────────

const PLAID_CATEGORY_MAP = {
  GROCERIES:              'Groceries',
  FOOD_AND_DRINK:         'Food & Dining',
  RESTAURANTS:            'Food & Dining',
  TRANSPORTATION:         'Transport',
  TRAVEL:                 'Transport',
  GENERAL_MERCHANDISE:    'Shopping',
  CLOTHING_AND_ACCESSORIES: 'Shopping',
  ONLINE_MARKETPLACES:    'Shopping',
  UTILITIES:              'Bills & Utilities',
  BILL_PAYMENTS:          'Bills & Utilities',
  ENTERTAINMENT:          'Entertainment',
  MEDICAL:                'Health',
  PERSONAL_CARE:          'Health',
};

function normalizeCategory(transaction) {
  if (transaction.personal_finance_category) {
    const primary = transaction.personal_finance_category.primary;
    if (PLAID_CATEGORY_MAP[primary]) return PLAID_CATEGORY_MAP[primary];
    if (primary === 'FOOD_AND_DRINK') {
      const d = transaction.personal_finance_category.detailed || '';
      if (d.includes('GROCERY') || d.includes('SUPERMARKET')) return 'Groceries';
    }
  }
  if (transaction.category && transaction.category.length > 0) {
    for (let i = transaction.category.length - 1; i >= 0; i--) {
      const cat = transaction.category[i].toLowerCase();
      if (cat === 'food and drink') return 'Food & Dining';
      if (cat === 'supermarkets and grocers') return 'Groceries';
      if (cat === 'travel') return 'Transport';
      if (cat === 'shops') return 'Shopping';
      if (cat === 'recreation') return 'Entertainment';
      if (cat === 'healthcare') return 'Health';
      if (cat === 'service' || cat === 'payment') return 'Bills & Utilities';
    }
  }
  return 'Other';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Exchange a public_token for an access_token and store in plaid_tokens table.
 * Triggers initial sync of last 48h of transactions.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {string} publicToken  — from Plaid Link
 * @returns {Promise<{ connected: boolean, institution?: string }>}
 */
async function connect(pool, userId, publicToken) {
  const plaid = getPlaidClient();
  if (!plaid) {
    throw new Error('PLAID_NOT_CONFIGURED');
  }

  const exchange = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  const { access_token, item_id } = exchange.data;

  // Fetch institution metadata for display + storage
  let institutionName = 'Unknown Bank';
  let institutionId = null;
  try {
    const instResponse = await plaid.itemGet({ access_token });
    institutionName = instResponse.data.item?.institution_id || institutionName;
    institutionId = instResponse.data.item?.institution_id || null;
  } catch {
    // Non-fatal — institution info is optional
  }

  // Upsert token to plaid_tokens
  const { upsertPlaidToken } = require('../db/transactions');
  await upsertPlaidToken(pool, {
    userId,
    encryptedAccessToken: encryptToken(access_token),
    itemId,
    institutionName,
    institutionId,
  });

  // Initial sync — last 48h
  syncDaily(pool, userId).catch(err =>
    console.error('[PlaidService] initial sync error:', err.message)
  );

  return { connected: true, institution: institutionName };
}

/**
 * Remove the Plaid connection for a user.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<{ disconnected: boolean }>}
 */
async function disconnect(pool, userId) {
  const { getPlaidToken, deletePlaidToken } = require('../db/transactions');
  const tokenRow = await getPlaidToken(pool, userId);

  if (tokenRow) {
    const plaid = getPlaidClient();
    if (plaid) {
      try {
        const accessToken = decryptToken(tokenRow.access_token);
        await plaid.itemRemove({ access_token: accessToken });
      } catch (e) {
        console.warn('[PlaidService] itemRemove failed:', e.message);
      }
    }
    await deletePlaidToken(pool, userId);
  }

  return { disconnected: true };
}

/**
 * Fetch transactions from Plaid API and upsert to the transactions table.
 * Returns normalized transactions.
 *
 * @param {object} pool
 * @param {number} userId
 * @param {{ from?: string, to?: string, limit?: number }} opts
 * @returns {Promise<object[]>} normalized transactions
 */
async function getTransactions(pool, userId, opts = {}) {
  const { from, to, limit = 100 } = opts;
  const { getPlaidToken, upsertTransaction } = require('../db/transactions');

  const tokenRow = await getPlaidToken(pool, userId);
  if (!tokenRow) return [];

  const plaid = getPlaidClient();
  if (!plaid) return [];

  const accessToken = decryptToken(tokenRow.access_token);

  // Use transactionsSync with cursor for consistent deduplication
  let cursor = tokenRow.cursor || null;
  let hasMore = true;
  let added = 0;
  const transactions = [];

  while (hasMore) {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: limit,
    });

    const { added: newTxs, modified: _modified, removed, next_cursor, has_more } = response.data;

    // Process added
    for (const tx of newTxs) {
      if (tx.amount <= 0) continue; // skip credits/refunds

      const category = normalizeCategory(tx);
      const normalized = {
        plaid_transaction_id: tx.transaction_id,
        user_id: userId,
        merchant_name: tx.merchant_name || tx.name || 'Unknown',
        amount: Math.round(tx.amount * 100), // store in cents
        category,
        category_icon: getCategoryIcon(category),
        date: tx.date,
        pending: tx.pending || false,
        logo_url: null,
      };

      const row = await upsertTransaction(pool, normalized);
      transactions.push(row);
      added++;
    }

    // Handle removed — delete from local ledger
    for (const removedTx of removed) {
      await pool.query(
        'DELETE FROM transactions WHERE plaid_transaction_id = $1 AND user_id = $2',
        [removedTx.transaction_id, userId]
      );
    }

    cursor = next_cursor;
    hasMore = has_more;
    if (!hasMore) break;
  }

  // Persist cursor
  if (cursor) {
    await pool.query(
      'UPDATE plaid_tokens SET cursor = $1, updated_at = NOW() WHERE user_id = $2',
      [cursor, userId]
    );
  }

  // If from/to range was specified, filter in-memory (Plaid sync fetches recent only)
  let result = transactions;
  if (from) {
    result = result.filter(t => t.date >= from);
  }
  if (to) {
    result = result.filter(t => t.date <= to);
  }

  return result;
}

/**
 * Daily sync: pull last 48h of transactions, idempotent upsert.
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<number>} count of new transactions added
 */
async function syncDaily(pool, userId) {
  const { from, to } = getLast48hWindow();
  const txs = await getTransactions(pool, userId, { from, to, limit: 100 });
  return txs.length;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getLast48hWindow() {
  const to = new Date();
  const from = new Date(to.getTime() - 48 * 60 * 60 * 1000);
  return {
    from: from.toISOString().split('T')[0],
    to:   to.toISOString().split('T')[0],
  };
}

/**
 * Fetch accounts + balances for a user from Plaid.
 * Falls back to stored institution name from plaid_items if Plaid unavailable.
 *
 * @param {object} pool
 * @param {number} userId
 * @returns {Promise<{ connected: boolean, institution?: string, lastSynced?: string, accounts: object[] }>}
 */
async function getAccounts(pool, userId) {
  // First, check if user has a Plaid connection
  const { getPlaidToken } = require('../db/transactions');
  const tokenRow = await getPlaidToken(pool, userId);

  if (!tokenRow) {
    return { connected: false, accounts: [] };
  }

  const institutionName = tokenRow.institution_name || 'Connected Account';
  const lastSynced = tokenRow.updated_at
    ? new Date(tokenRow.updated_at).toISOString()
    : null;

  // Try to get live balances from Plaid
  const plaid = getPlaidClient();
  if (!plaid) {
    return {
      connected: true,
      institution: institutionName,
      lastSynced,
      accounts: [],
    };
  }

  try {
    const accessToken = decryptToken(tokenRow.access_token);
    const response = await plaid.accountsGet({ access_token: accessToken });
    const accounts = (response.data.accounts || []).map(acc => ({
      id: acc.account_id,
      name: acc.name,
      officialName: acc.official_name || null,
      type: acc.type,
      subtype: acc.subtype || null,
      mask: acc.mask || null,
      balance: {
        available: acc.balances.available,
        current: acc.balances.current,
        isoCurrencyCode: acc.balances.iso_currency_code || 'USD',
      },
    }));
    return {
      connected: true,
      institution: institutionName,
      lastSynced,
      accounts,
    };
  } catch (err) {
    console.warn('[PlaidService] getAccounts failed:', err.message);
    return {
      connected: true,
      institution: institutionName,
      lastSynced,
      accounts: [],
    };
  }
}

module.exports = { connect, disconnect, getTransactions, syncDaily, getAccounts };