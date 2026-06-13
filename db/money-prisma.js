// db/money-prisma.js — pg.Pool-backed query functions for money/expense/transaction data.
// Owns: expense CRUD, plaid transaction queries, spending aggregates, category mapping.
// Does NOT own: auth middleware, plaid token encryption (see routes/plaid.js).
// All functions accept pool as first argument.

// ── Category helpers ──────────────────────────────────────────────────────────

// Map FocusLedger slugs → legacy category table names
const SLUG_TO_NAME = {
  housing:       'Housing',
  bills:         'Bills',
  groceries:     'Groceries',
  food_delivery: 'Food & Delivery',
  subscriptions: 'Subscriptions',
  shopping:      'Shopping',
  transport:     'Transport',
  health:        'Health',
  fun:           'Fun',
  other:         'Other',
};

// Resolve a FocusLedger slug to a categories.id, falling back to 'Other'
async function resolveCategoryId(pool, slug) {
  const targetName = SLUG_TO_NAME[slug] || 'Other';
  const { rows } = await pool.query(
    'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [targetName]
  );
  if (rows.length) return rows[0].id;
  const { rows: fallback } = await pool.query(
    "SELECT id FROM categories WHERE LOWER(name) = 'other' LIMIT 1"
  );
  return fallback[0]?.id || null;
}

// Map Plaid category string → FocusLedger slug
function plaidCategoryToSlug(plaidCategory) {
  if (!plaidCategory) return 'other';
  const upper = plaidCategory.toUpperCase();
  if (upper.includes('GROCERY') || upper.includes('SUPERMARKET')) return 'groceries';
  if (upper.includes('FOOD_AND_DRINK') || upper.includes('RESTAURANT') ||
      upper.includes('FAST_FOOD') || upper.includes('DOORDASH') || upper.includes('GRUBHUB') ||
      upper.includes('COFFEE') || upper.includes('DELIVERY')) return 'food_delivery';
  if (upper.includes('RENT_AND_UTILITIES') || upper.includes('MORTGAGE')) return 'housing';
  if (upper.includes('SUBSCRIPTION') || upper.includes('STREAMING')) return 'subscriptions';
  if (upper.includes('TRANSPORTATION') || upper.includes('TRAVEL') ||
      upper.includes('RIDESHARE') || upper.includes('GAS') || upper.includes('PARKING')) return 'transport';
  if (upper.includes('MEDICAL') || upper.includes('PHARMACY') || upper.includes('HEALTH') ||
      upper.includes('PERSONAL_CARE') || upper.includes('FITNESS')) return 'health';
  if (upper.includes('ENTERTAINMENT') || upper.includes('RECREATION') ||
      upper.includes('SPORT')) return 'fun';
  if (upper.includes('UTILITIES') || upper.includes('BILL_PAYMENT') || upper.includes('LOAN') ||
      upper.includes('TELECOM') || upper.includes('INTERNET') || upper.includes('PHONE')) return 'bills';
  if (upper.includes('SHOP') || upper.includes('AMAZON') || upper.includes('CLOTHING') ||
      upper.includes('ONLINE_MARKETPLACE') || upper.includes('GENERAL_MERCHANDISE')) return 'shopping';
  return 'other';
}

// ── Expense CRUD ─────────────────────────────────────────────────────────────

// Create a manual expense entry
async function createExpense(pool, { userId, amount, categorySlug, isImpulse, note, expenseDate, localDate }) {
  const categoryId = await resolveCategoryId(pool, categorySlug || 'other');
  const descVal = note || SLUG_TO_NAME[categorySlug] || 'Manual expense';
  const effectiveDate = expenseDate || localDate || new Date().toISOString().split('T')[0];

  const cols = ['user_id', 'amount', 'description', 'expense_date', 'source'];
  const vals = [userId, amount, descVal, effectiveDate, 'manual'];
  let idx = vals.length;

  if (categoryId != null) { cols.push('category_id'); vals.push(categoryId); idx++; }
  if (isImpulse !== undefined && isImpulse !== null) { cols.push('is_impulse'); vals.push(isImpulse); idx++; }

  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
    vals
  );
  return rows[0];
}

// Fetch expenses for a user within a date range
async function getExpenses(pool, userId, period, localDate) {
  const { weekStart, weekEnd } = getWeekBounds(localDate);
  let dateWhere = '';
  const vals = [userId];
  let idx = 2;

  if (period === 'month') {
    const monthStart = (localDate || new Date().toISOString().split('T')[0]).slice(0, 7) + '-01';
    dateWhere = ` AND e.expense_date >= $${idx++}`;
    vals.push(monthStart);
  } else if (period !== 'all') {
    dateWhere = ` AND e.expense_date >= $${idx++} AND e.expense_date <= $${idx++}`;
    vals.push(weekStart, weekEnd);
  }

  const sql = `
    SELECT e.*, c.name as category_name, c.icon as category_icon, c.color as category_color
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    WHERE e.user_id = $1${dateWhere}
    ORDER BY e.expense_date DESC, e.created_at DESC
  `;
  const { rows } = await pool.query(sql, vals);
  return rows;
}

// Fetch un-triaged Plaid expenses from last 7 days (amount desc, limit 10)
async function getUntriagedExpenses(pool, userId, localDate) {
  const refDate = localDate || new Date().toISOString().split('T')[0];
  const cutoff = new Date(refDate + 'T00:00:00Z');
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const sql = `
    SELECT e.*, c.name as category_name, c.icon as category_icon
    FROM expenses e
    LEFT JOIN categories c ON e.category_id = c.id
    WHERE e.user_id = $1 AND e.source = 'plaid' AND e.is_impulse IS NULL AND e.expense_date >= $2
    ORDER BY e.amount DESC
    LIMIT 10
  `;
  const { rows } = await pool.query(sql, [userId, cutoffStr]);
  return rows;
}

// Triage an expense (set is_impulse + optional category)
async function triageExpense(pool, expenseId, userId, isImpulse, categorySlug) {
  let categoryId = null;
  if (categorySlug) {
    categoryId = await resolveCategoryId(pool, categorySlug);
  }

  const setCols = ['is_impulse = $1', 'updated_at = NOW()'];
  const vals = [isImpulse];
  let idx = 2;

  if (categoryId != null) {
    setCols.push(`category_id = $${idx++}`);
    vals.push(categoryId);
  }

  vals.push(expenseId, userId);
  const sql = `
    UPDATE expenses SET ${setCols.join(', ')}
    WHERE id = $${idx++} AND user_id = $${idx++}
    RETURNING *
  `;
  const { rows } = await pool.query(sql, vals);
  if (!rows.length) return null;

  // Fetch with category info
  const { rows: enriched } = await pool.query(
    `SELECT e.*, c.name as category_name, c.icon as category_icon, c.color as category_color
     FROM expenses e LEFT JOIN categories c ON e.category_id = c.id
     WHERE e.id = $1`,
    [rows[0].id]
  );
  return enriched[0] || rows[0];
}

// Aggregate spending: total, by category, impulse breakdown
async function getSpendingSummary(pool, userId, period, localDate) {
  const { weekStart, weekEnd } = getWeekBounds(localDate);
  let startDate, endDate;
  if (period === 'month') {
    const [y, m] = (localDate || new Date().toISOString().split('T')[0]).split('-');
    startDate = `${y}-${m}-01`;
    endDate = localDate || new Date().toISOString().split('T')[0];
  } else {
    startDate = weekStart;
    endDate = weekEnd;
  }

  const [totRow, catRows, impulseRows] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [userId, startDate, endDate]
    ),
    pool.query(
      `SELECT e.category_id, c.name AS category_name, c.icon AS category_icon,
              COALESCE(SUM(e.amount), 0) AS total, COUNT(e.id)::int AS count
       FROM expenses e LEFT JOIN categories c ON e.category_id = c.id
       WHERE e.user_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
         AND e.category_id IS NOT NULL
       GROUP BY e.category_id, c.name, c.icon
       ORDER BY total DESC`,
      [userId, startDate, endDate]
    ),
    pool.query(
      `SELECT amount, is_impulse, source FROM expenses
       WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [userId, startDate, endDate]
    ),
  ]);

  const total = parseFloat(totRow.rows[0].total || 0);
  let impulse_total = 0, planned_total = 0, untriaged_total = 0;
  let impulse_count = 0, untriaged_count = 0;
  for (const e of impulseRows.rows) {
    if (e.is_impulse === true) { impulse_total += parseFloat(e.amount); impulse_count++; }
    else if (e.is_impulse === false) { planned_total += parseFloat(e.amount); }
    else if (e.source === 'plaid') { untriaged_total += parseFloat(e.amount); untriaged_count++; }
  }

  const byCategoryNamed = catRows.rows.map(b => ({
    category_name: b.category_name || 'Other',
    category_icon: b.category_icon || '📦',
    total: parseFloat(b.total || 0),
    count: b.count,
  }));

  return {
    period,
    start_date: startDate,
    end_date: endDate,
    total,
    impulse_total,
    planned_total,
    untriaged_total,
    impulse_count,
    untriaged_count,
    impulse_pct: total > 0 ? Math.round((impulse_total / total) * 100) : 0,
    by_category: byCategoryNamed,
  };
}

// Today's spend stats
async function getTodaySpend(pool, userId, localDate) {
  const today = localDate || new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT amount, is_impulse, source FROM expenses
     WHERE user_id = $1 AND expense_date = $2`,
    [userId, today]
  );

  let total = 0, impulse = 0, planned = 0, untriaged = 0;
  for (const e of rows) {
    const amt = parseFloat(e.amount);
    total += amt;
    if (e.is_impulse === true) impulse += amt;
    else if (e.is_impulse === false) planned += amt;
    else if (e.source === 'plaid') untriaged++;
  }

  return { total, impulse, planned, untriaged };
}

// ── Plaid transaction helpers ──────────────────────────────────────────────────

// Count unconfirmed transactions for a user
async function countPendingReview(pool, userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS c FROM plaid_transactions WHERE user_id = $1 AND is_confirmed = false AND is_pending = false',
    [userId]
  );
  return rows[0].c;
}

// Fetch unconfirmed Plaid transactions for review (with category + account info)
async function getPendingTransactions(pool, userId) {
  const sql = `
    SELECT pt.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
           pa.name as account_name, pa.mask
    FROM plaid_transactions pt
    LEFT JOIN categories c ON pt.category_id = c.id
    LEFT JOIN plaid_accounts pa ON pt.plaid_account_id = pa.id
    WHERE pt.user_id = $1 AND pt.is_confirmed = false AND pt.is_pending = false
    ORDER BY pt.transaction_date DESC, pt.created_at DESC
    LIMIT 50
  `;
  const { rows } = await pool.query(sql, [userId]);
  return rows;
}

// Confirm a Plaid transaction → create expense
async function confirmTransaction(pool, plaidTxId, userId) {
  const { rows: txRows } = await pool.query(
    'SELECT * FROM plaid_transactions WHERE id = $1 AND user_id = $2 AND is_confirmed = false',
    [plaidTxId, userId]
  );
  if (!txRows.length) return null;
  const tx = txRows[0];

  const expDate = tx.transaction_date
    ? String(tx.transaction_date).slice(0, 10)
    : new Date().toISOString().split('T')[0];

  const cols = ['user_id', 'amount', 'description', 'expense_date', 'source'];
  const vals = [userId, parseFloat(tx.amount), tx.description || tx.merchant_name || 'Unknown', expDate, 'plaid'];
  let idx = vals.length;

  if (tx.category_id != null) { cols.push('category_id'); vals.push(tx.category_id); idx++; }
  if (tx.transaction_id) { cols.push('plaid_transaction_id'); vals.push(tx.transaction_id); idx++; }

  const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
  const { rows: expRows } = await pool.query(
    `INSERT INTO expenses (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
    vals
  );
  const expense = expRows[0];

  await pool.query(
    'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
    [expense.id, plaidTxId]
  );

  return { expenseId: expense.id, tx };
}

// Dismiss a transaction (mark confirmed without creating expense)
async function dismissTransaction(pool, plaidTxId, userId) {
  const { rows } = await pool.query(
    'SELECT id FROM plaid_transactions WHERE id = $1 AND user_id = $2',
    [plaidTxId, userId]
  );
  if (!rows.length) return false;
  await pool.query(
    'UPDATE plaid_transactions SET is_confirmed = true, updated_at = NOW() WHERE id = $1',
    [plaidTxId]
  );
  return true;
}

// Update category on unconfirmed transaction
async function recategorizeTransaction(pool, plaidTxId, userId, categorySlug) {
  const categoryId = await resolveCategoryId(pool, categorySlug);
  const { rows } = await pool.query(
    'SELECT id FROM plaid_transactions WHERE id = $1 AND user_id = $2',
    [plaidTxId, userId]
  );
  if (!rows.length) return false;
  await pool.query(
    'UPDATE plaid_transactions SET category_id = $1, updated_at = NOW() WHERE id = $2',
    [categoryId, plaidTxId]
  );
  return true;
}

// Get Plaid items with accounts for a user (for Account Summary card)
async function getPlaidItemsWithAccounts(pool, userId) {
  // Avoid GROUP BY pi.id (fails with 42803 if id lacks PK constraint) — two queries + JS merge
  const { rows: items } = await pool.query(
    'SELECT * FROM plaid_items WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  if (!items.length) return [];
  const { rows: accounts } = await pool.query(
    'SELECT * FROM plaid_accounts WHERE plaid_item_id = ANY($1)',
    [items.map(i => i.id)]
  );
  const accByItem = {};
  for (const a of accounts) (accByItem[a.plaid_item_id] = accByItem[a.plaid_item_id] || []).push(a);
  return items.map(item => ({ ...item, plaid_accounts: accByItem[item.id] || [] }));
}

// Upsert a plaid_item (called after token exchange)
async function upsertPlaidItem(pool, userId, encryptedAccessToken, itemId, institutionName, institutionId) {
  const { rows } = await pool.query(
    `INSERT INTO plaid_items (user_id, access_token, item_id, institution_name, institution_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, encryptedAccessToken, itemId, institutionName || 'Unknown Bank', institutionId || null]
  );
  return rows[0];
}

// Delete a plaid_item (disconnect)
async function deletePlaidItem(pool, itemId, userId) {
  await pool.query(
    'DELETE FROM plaid_items WHERE id = $1 AND user_id = $2',
    [itemId, userId]
  );
}

// Update item cursor after sync
async function updateItemCursor(pool, itemId, cursor) {
  await pool.query(
    'UPDATE plaid_items SET cursor = $1, last_synced_at = NOW() WHERE id = $2',
    [cursor, itemId]
  );
}

// Upsert a Plaid account
async function upsertPlaidAccount(pool, plaidItemId, userId, accountId, name, officialName, type, subtype, mask, currentBalance, availableBalance) {
  const { rows } = await pool.query(
    `INSERT INTO plaid_accounts (plaid_item_id, user_id, account_id, name, official_name, type, subtype, mask, current_balance, available_balance, balance_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (account_id) DO UPDATE SET
       name = EXCLUDED.name,
       mask = EXCLUDED.mask,
       current_balance    = COALESCE(EXCLUDED.current_balance,    plaid_accounts.current_balance),
       available_balance  = COALESCE(EXCLUDED.available_balance,  plaid_accounts.available_balance),
       balance_updated_at = CASE WHEN EXCLUDED.current_balance IS NOT NULL THEN NOW() ELSE plaid_accounts.balance_updated_at END
     RETURNING *`,
    [plaidItemId, userId, accountId, name, officialName || null, type, subtype || null, mask || null,
     currentBalance != null ? currentBalance : null,
     availableBalance != null ? availableBalance : null]
  );
  return rows[0];
}

// Get account_id → db id map for a plaid_item
async function getAccountMap(pool, plaidItemId) {
  const { rows } = await pool.query(
    'SELECT id, account_id FROM plaid_accounts WHERE plaid_item_id = $1',
    [plaidItemId]
  );
  const map = {};
  for (const a of rows) map[a.account_id] = a.id;
  return map;
}

// Get all categories as { name → row } map
async function getCategoriesMap(pool) {
  const { rows } = await pool.query('SELECT id, name FROM categories');
  const map = {};
  for (const c of rows) map[c.name.toLowerCase()] = c;
  return map;
}

// Insert a Plaid transaction (dedup by transaction_id)
async function insertPlaidTransaction(pool, params) {
  const { plaidAccountId, userId, transactionId, amount, description, merchantName, categoryId, plaidCategory, transactionDate, isPending } = params;
  try {
    const txDate = transactionDate ? String(transactionDate).slice(0, 10) : null;
    const { rows } = await pool.query(
      `INSERT INTO plaid_transactions
         (plaid_account_id, user_id, transaction_id, amount, description, merchant_name, category_id, plaid_category, transaction_date, is_pending)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING *`,
      [plaidAccountId, userId, transactionId, parseFloat(amount), description, merchantName || null,
       categoryId || null, plaidCategory || null, txDate, isPending || false]
    );
    return rows[0] || null;
  } catch {
    return null; // silently ignore duplicates or schema mismatches
  }
}

// Get unconfirmed Plaid transactions for a user (for sync)
async function getUnconfirmedPlaidTransactions(pool, userId) {
  const { rows } = await pool.query(
    'SELECT id, transaction_id, transaction_date FROM plaid_transactions WHERE user_id = $1 AND is_confirmed = false AND is_pending = false',
    [userId]
  );
  return rows;
}

// Bulk update plaid_transactions (mark confirmed or update category)
async function markTransactionsConfirmed(pool, plaidTxIds, expenseIds) {
  for (let i = 0; i < plaidTxIds.length; i++) {
    await pool.query(
      'UPDATE plaid_transactions SET is_confirmed = true, expense_id = $1, updated_at = NOW() WHERE id = $2',
      [expenseIds[i], plaidTxIds[i]]
    );
  }
}

// Bill preferences
async function getBillPreferences(pool, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM bill_preferences WHERE user_id = $1 ORDER BY merchant_display_name ASC',
    [userId]
  );
  return rows;
}

async function upsertBillPreference(pool, userId, merchantKey, isDisabled, merchantDisplayName, billType) {
  const { rows } = await pool.query(
    `INSERT INTO bill_preferences (user_id, merchant_key, is_disabled, merchant_display_name, bill_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, merchant_key) DO UPDATE SET is_disabled = EXCLUDED.is_disabled, updated_at = NOW()
     RETURNING *`,
    [userId, merchantKey, isDisabled, merchantDisplayName || null, billType || null]
  );
  return rows[0];
}

async function trackBillMerchant(pool, userId, merchantKey, merchantDisplayName, billType) {
  const { rows } = await pool.query(
    `INSERT INTO bill_preferences (user_id, merchant_key, merchant_display_name, bill_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, merchant_key) DO UPDATE SET merchant_display_name = EXCLUDED.merchant_display_name, bill_type = EXCLUDED.bill_type, updated_at = NOW()
     RETURNING *`,
    [userId, merchantKey, merchantDisplayName, billType]
  );
  return rows[0];
}

async function getDisabledMerchantKeys(pool, userId) {
  const { rows } = await pool.query(
    'SELECT merchant_key FROM bill_preferences WHERE user_id = $1 AND is_disabled = true',
    [userId]
  );
  return new Set(rows.map(p => p.merchant_key));
}

// ── Spending aggregates ───────────────────────────────────────────────────────

async function getAggregateData(pool, userId, from, to) {
  const { weekStart } = getWeekBounds();
  const startStr = from || weekStart;
  const endStr   = to   || new Date().toISOString().split('T')[0];

  const [totRow, catRows] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [userId, startStr, endStr]
    ),
    pool.query(
      `SELECT e.category_id, c.name AS category_name, c.icon AS category_icon,
              COALESCE(SUM(e.amount), 0) AS total, COUNT(e.id)::int AS count
       FROM expenses e LEFT JOIN categories c ON e.category_id = c.id
       WHERE e.user_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
         AND e.category_id IS NOT NULL
       GROUP BY e.category_id, c.name, c.icon
       ORDER BY total DESC`,
      [userId, startStr, endStr]
    ),
  ]);

  const by_category = catRows.rows.map(b => ({
    category: b.category_name || 'Other',
    category_icon: b.category_icon || '📦',
    total: (parseFloat(b.total || 0) * 100).toFixed(0), // return as cents for compat
    count: b.count,
  }));

  return {
    total_spend: parseFloat(totRow.rows[0].total || 0) * 100, // cents
    by_category,
  };
}

async function getSpendingStatsData(pool, userId) {
  const { rows } = await pool.query(
    'SELECT is_impulse FROM expenses WHERE user_id = $1 AND is_impulse IS NOT NULL',
    [userId]
  );

  const total_classified = rows.length;
  const impulse_count = rows.filter(e => e.is_impulse === true).length;
  const planned_count = rows.filter(e => e.is_impulse === false).length;

  return { total_classified, impulse_count, planned_count };
}

async function getFirstExpenseDate(pool, userId) {
  const { rows } = await pool.query(
    'SELECT MIN(expense_date) AS first_date FROM expenses WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.first_date || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWeekBounds(localDate) {
  const now = localDate ? new Date(localDate + 'T12:00:00Z') : new Date();
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setUTCDate(diff);
  const weekStart = monday.toISOString().split('T')[0];
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { weekStart, weekEnd: sunday.toISOString().split('T')[0] };
}

module.exports = {
  plaidCategoryToSlug,
  resolveCategoryId,
  createExpense,
  getExpenses,
  getUntriagedExpenses,
  triageExpense,
  getSpendingSummary,
  getTodaySpend,
  countPendingReview,
  getPendingTransactions,
  confirmTransaction,
  dismissTransaction,
  recategorizeTransaction,
  getPlaidItemsWithAccounts,
  upsertPlaidItem,
  deletePlaidItem,
  updateItemCursor,
  upsertPlaidAccount,
  getAccountMap,
  getCategoriesMap,
  insertPlaidTransaction,
  getUnconfirmedPlaidTransactions,
  markTransactionsConfirmed,
  getBillPreferences,
  upsertBillPreference,
  trackBillMerchant,
  getDisabledMerchantKeys,
  getWeekBounds,
  getAggregateData,
  getSpendingStatsData,
  getFirstExpenseDate,
};
