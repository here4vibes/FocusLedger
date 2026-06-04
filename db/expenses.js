'use strict';
/**
 * db/expenses.js — Named query functions for the expenses table.
 *
 * Tables owned: expenses, categories, budgets
 *
 * Does NOT own: plaid_transactions (see db/plaid.js),
 *               task matching logic (see routes/plaid.js helpers)
 */

// Valid FocusLedger expense categories (slug → display label)
const VALID_CATEGORIES = {
  housing:       '🏠 Housing',
  bills:         '📄 Bills',
  groceries:     '🛒 Groceries',
  food_delivery: '🍕 Food & Delivery',
  subscriptions: '🔄 Subscriptions',
  shopping:      '🛍️ Shopping',
  transport:     '🚗 Transport',
  health:        '🏥 Health',
  fun:           '🎮 Fun',
  other:         '📦 Other',
};

// Map legacy category names (from categories table) → slug
const LEGACY_NAME_TO_SLUG = {
  'food & dining':    'food_delivery',
  'food & delivery':  'food_delivery',
  'groceries':        'groceries',
  'shopping':         'shopping',
  'bills & utilities':'bills',
  'entertainment':    'fun',
  'health':           'health',
  'transport':        'transport',
  'other':            'other',
  'housing':          'housing',
  'subscriptions':    'subscriptions',
};

/**
 * Resolve a category slug (from VALID_CATEGORIES) to a categories.id.
 * Falls back to 'other' if not found.
 * @param {object} pool
 * @param {string} slug  - one of the VALID_CATEGORIES keys
 * @returns {Promise<number|null>}
 */
async function resolveCategoryId(pool, slug) {
  // Direct name lookup — categories table uses legacy "Food & Dining" style names
  const normalized = slug ? slug.toLowerCase().replace(/_/g, ' ') : '';

  // Try slug → legacy-name mapping first
  const legacyMappings = {
    housing:       'Housing',
    bills:         'Bills & Utilities',
    groceries:     'Groceries',
    food_delivery: 'Food & Dining',
    subscriptions: 'Subscriptions',
    shopping:      'Shopping',
    transport:     'Transport',
    health:        'Health',
    fun:           'Entertainment',
    other:         'Other',
  };

  const targetName = legacyMappings[slug] || 'Other';
  const result = await pool.query(
    'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [targetName]
  );
  if (result.rows.length > 0) return result.rows[0].id;

  // Last resort — any category
  const fallback = await pool.query('SELECT id FROM categories WHERE LOWER(name) = \'other\' LIMIT 1');
  return fallback.rows[0]?.id || null;
}

/**
 * Map a Plaid category string (e.g. "FOOD_AND_DRINK/RESTAURANTS_FAST_FOOD") to a slug.
 * @param {string} plaidCategory
 * @returns {string} slug
 */
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

/**
 * Create a manual expense entry.
 * @param {object} pool
 * @param {object} params
 * @param {string} [params.localDate] — YYYY-MM-DD in user's timezone (fallback for expenseDate)
 * @returns {Promise<object>} inserted expense row
 */
async function createExpense(pool, params) {
  const {
    userId, amount, categorySlug, isImpulse, note, expenseDate, localDate
  } = params;

  const categoryId = await resolveCategoryId(pool, categorySlug || 'other');
  const noteVal = note || null;
  // description = note if provided, otherwise the category label for readability
  const descVal = noteVal || (VALID_CATEGORIES[categorySlug] || 'Manual expense');
  // WHY localDate fallback: new Date().toISOString() is UTC — wrong at 11 PM ET
  const effectiveDate = expenseDate || localDate || new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `INSERT INTO expenses
       (user_id, amount, category_id, is_impulse, note, expense_date, source, description)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
     RETURNING *`,
    [userId, amount, categoryId, isImpulse ?? null, noteVal, effectiveDate, descVal]
  );
  return result.rows[0];
}

/**
 * Import a Plaid transaction as an expense (is_impulse = NULL for later triage).
 * Deduplicates by plaid_transaction_id.
 * @param {object} pool
 * @param {object} params
 * @returns {Promise<object|null>} inserted row, or null if duplicate
 */
async function importPlaidExpense(pool, params) {
  const {
    userId, amount, merchantName, plaidTransactionId, plaidOriginalCategory,
    categorySlug, transactionDate
  } = params;

  const categoryId = await resolveCategoryId(pool, categorySlug || 'other');

  const result = await pool.query(
    `INSERT INTO expenses
       (user_id, amount, description, category_id, is_impulse, expense_date,
        source, plaid_transaction_id, plaid_original_category)
     VALUES ($1, $2, $3, $4, NULL, $5, 'plaid', $6, $7)
     ON CONFLICT (plaid_transaction_id)
       WHERE plaid_transaction_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [userId, amount, merchantName || 'Unknown', categoryId, transactionDate,
     plaidTransactionId, plaidOriginalCategory || null]
  );
  return result.rows[0] || null;
}

/**
 * Fetch expenses for a user within a date range.
 * @param {object} pool
 * @param {number} userId
 * @param {string} period - 'week' | 'month' | 'all'
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone; used instead of CURRENT_DATE
 * @returns {Promise<object[]>}
 */
async function getExpenses(pool, userId, period, localDate) {
  let dateFilter = '';
  const params = [userId];

  if (period === 'month') {
    // WHY param: CURRENT_DATE is UTC on Neon — month boundary must use user's local date
    const refDate = localDate || new Date().toISOString().split('T')[0];
    dateFilter = `AND e.expense_date >= date_trunc('month', $2::date)`;
    params.push(refDate);
  } else if (period === 'all') {
    // no filter
  } else {
    // default: current week (Mon–Sun)
    const { weekStart, weekEnd } = getWeekBounds(localDate);
    dateFilter = `AND e.expense_date >= $2 AND e.expense_date <= $3`;
    params.push(weekStart, weekEnd);
  }

  const result = await pool.query(`
    SELECT e.*,
           c.name AS category_name, c.color AS category_color, c.icon AS category_icon
    FROM expenses e
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE e.user_id = $1 ${dateFilter}
    ORDER BY e.expense_date DESC, e.created_at DESC
  `, params);

  return result.rows;
}

/**
 * Fetch recent Plaid-imported expenses where is_impulse IS NULL (not yet triaged).
 * Capped at 10; sorted by amount desc so user sees biggest ones first.
 * @param {object} pool
 * @param {number} userId
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 * @returns {Promise<object[]>}
 */
async function getUntriagedExpenses(pool, userId, localDate) {
  // WHY param: CURRENT_DATE is UTC on Neon — 7-day window must anchor to user's local date
  const refDate = localDate || new Date().toISOString().split('T')[0];
  const result = await pool.query(`
    SELECT e.*,
           c.name AS category_name, c.icon AS category_icon
    FROM expenses e
    LEFT JOIN categories c ON c.id = e.category_id
    WHERE e.user_id = $1
      AND e.source = 'plaid'
      AND e.is_impulse IS NULL
      AND e.expense_date >= $2::date - INTERVAL '7 days'
    ORDER BY e.amount DESC
    LIMIT 10
  `, [userId, refDate]);
  return result.rows;
}

/**
 * Update is_impulse (and optionally category) on an expense.
 * @param {object} pool
 * @param {number} expenseId
 * @param {number} userId
 * @param {boolean} isImpulse
 * @param {string|null} categorySlug - optional override
 * @returns {Promise<object|null>}
 */
async function triageExpense(pool, expenseId, userId, isImpulse, categorySlug) {
  let categoryId = null;
  if (categorySlug) {
    categoryId = await resolveCategoryId(pool, categorySlug);
  }

  const result = categoryId
    ? await pool.query(
        `UPDATE expenses
         SET is_impulse = $1, category_id = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4
         RETURNING *`,
        [isImpulse, categoryId, expenseId, userId]
      )
    : await pool.query(
        `UPDATE expenses
         SET is_impulse = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING *`,
        [isImpulse, expenseId, userId]
      );

  return result.rows[0] || null;
}

/**
 * Aggregate spending by category + impulse breakdown for a period.
 * @param {object} pool
 * @param {number} userId
 * @param {string} period - 'week' | 'month'
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 * @returns {Promise<object>}
 */
async function getSpendingSummary(pool, userId, period, localDate) {
  const { weekStart, weekEnd } = getWeekBounds(localDate);
  let startDate, endDate;

  if (period === 'month') {
    // WHY: new Date() gives UTC — month-start must reflect user's local date
    const ref = localDate || new Date().toISOString().split('T')[0];
    const [y, m] = ref.split('-');
    startDate = `${y}-${m}-01`;
    endDate = ref;
  } else {
    startDate = weekStart;
    endDate = weekEnd;
  }

  const [totalRow, byCategory, impulseRow] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [userId, startDate, endDate]
    ),
    pool.query(
      `SELECT c.name AS category_name, c.icon AS category_icon,
              COALESCE(SUM(e.amount), 0) AS total,
              COUNT(e.id) AS count
       FROM expenses e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.user_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
       GROUP BY c.name, c.icon
       ORDER BY total DESC`,
      [userId, startDate, endDate]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE is_impulse = true), 0)  AS impulse_total,
         COALESCE(SUM(amount) FILTER (WHERE is_impulse = false), 0) AS planned_total,
         COALESCE(SUM(amount) FILTER (WHERE is_impulse IS NULL), 0) AS untriaged_total,
         COUNT(*) FILTER (WHERE is_impulse = true)                  AS impulse_count,
         COUNT(*) FILTER (WHERE is_impulse IS NULL AND source = 'plaid') AS untriaged_count
       FROM expenses
       WHERE user_id = $1 AND expense_date >= $2 AND expense_date <= $3`,
      [userId, startDate, endDate]
    ),
  ]);

  const total = parseFloat(totalRow.rows[0].total);
  const imp = impulseRow.rows[0];

  return {
    period,
    start_date: startDate,
    end_date: endDate,
    total,
    impulse_total: parseFloat(imp.impulse_total),
    planned_total: parseFloat(imp.planned_total),
    untriaged_total: parseFloat(imp.untriaged_total),
    impulse_count: parseInt(imp.impulse_count),
    untriaged_count: parseInt(imp.untriaged_count),
    impulse_pct: total > 0 ? Math.round((parseFloat(imp.impulse_total) / total) * 100) : 0,
    by_category: byCategory.rows,
  };
}

/**
 * Today's running spend for the dashboard widget.
 * @param {object} pool
 * @param {number} userId
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 * @returns {Promise<object>}
 */
async function getTodaySpend(pool, userId, localDate) {
  // WHY: new Date().toISOString() is UTC — at 11 PM ET it would show tomorrow's spend
  const today = localDate || new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0)                                    AS total,
       COALESCE(SUM(amount) FILTER (WHERE is_impulse = true), 0)   AS impulse,
       COALESCE(SUM(amount) FILTER (WHERE is_impulse = false), 0)  AS planned,
       COUNT(*) FILTER (WHERE is_impulse IS NULL AND source = 'plaid') AS untriaged
     FROM expenses
     WHERE user_id = $1 AND expense_date = $2`,
    [userId, today]
  );
  const row = result.rows[0];
  return {
    total: parseFloat(row.total),
    impulse: parseFloat(row.impulse),
    planned: parseFloat(row.planned),
    untriaged: parseInt(row.untriaged),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone; defaults to UTC today
 */
function getWeekBounds(localDate) {
  // WHY param: new Date() is UTC — week boundaries must match user's local calendar
  const now = localDate ? new Date(localDate + 'T12:00:00Z') : new Date();
  const day = now.getUTCDay(); // 0 = Sun, 1 = Mon, …
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setUTCDate(diff);
  const weekStart = monday.toISOString().split('T')[0];

  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const weekEnd = sunday.toISOString().split('T')[0];
  return { weekStart, weekEnd };
}

module.exports = {
  VALID_CATEGORIES,
  LEGACY_NAME_TO_SLUG,
  plaidCategoryToSlug,
  resolveCategoryId,
  createExpense,
  importPlaidExpense,
  getExpenses,
  getUntriagedExpenses,
  triageExpense,
  getSpendingSummary,
  getTodaySpend,
};
