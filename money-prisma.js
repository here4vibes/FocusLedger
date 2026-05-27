// db/money-prisma.js — Prisma-backed query functions for money/expense/transaction data.
// Owns: expense CRUD, plaid transaction queries, spending aggregates, category mapping.
// Does NOT own: auth middleware, plaid token encryption (see routes/plaid.js).
const { prisma } = require('../lib/prisma');

// ── Category helpers ──────────────────────────────────────────────────────────

// Map FocusLedger slugs → legacy category table names
const SLUG_TO_NAME = {
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

// Resolve a FocusLedger slug to a categories.id, falling back to 'Other'
async function resolveCategoryId(slug) {
  const targetName = SLUG_TO_NAME[slug] || 'Other';
  const cat = await prisma.categories.findFirst({ where: { name: { equals: targetName, mode: 'insensitive' } } });
  if (cat) return cat.id;
  const fallback = await prisma.categories.findFirst({ where: { name: { equals: 'Other', mode: 'insensitive' } } });
  return fallback?.id || null;
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
async function createExpense({ userId, amount, categorySlug, isImpulse, note, expenseDate, localDate }) {
  const categoryId = await resolveCategoryId(categorySlug || 'other');
  const descVal = note || SLUG_TO_NAME[categorySlug] || 'Manual expense';
  const effectiveDate = expenseDate || localDate || new Date().toISOString().split('T')[0];
  return prisma.expense.create({
    data: {
      user_id: userId,
      amount,
      category_id: categoryId,
      is_impulse: isImpulse ?? null,
      description: descVal,
      expense_date: new Date(effectiveDate + 'T00:00:00Z'),
      source: 'manual',
    },
  });
}

// Fetch expenses for a user within a date range
async function getExpenses(userId, period, localDate) {
  const { weekStart, weekEnd } = getWeekBounds(localDate);
  let dateFilter;
  if (period === 'month') {
    dateFilter = { expense_date: { gte: new Date(weekStart + 'T00:00:00Z').toISOString().slice(0, 7) + '-01' } };
  } else if (period !== 'all') {
    dateFilter = { expense_date: { gte: weekStart, lte: weekEnd } };
  }

  const where = { user_id: userId, ...dateFilter };
  const expenses = await prisma.expense.findMany({
    where,
    orderBy: [{ expense_date: 'desc' }, { created_at: 'desc' }],
    include: { categories: { select: { name: true, icon: true, color: true } } },
  });
  return expenses;
}

// Fetch un-triaged Plaid expenses from last 7 days (amount desc, limit 10)
async function getUntriagedExpenses(userId, localDate) {
  const refDate = localDate || new Date().toISOString().split('T')[0];
  const cutoff = new Date(refDate + 'T00:00:00Z');
  cutoff.setDate(cutoff.getDate() - 7);
  return prisma.expense.findMany({
    where: {
      user_id: userId,
      source: 'plaid',
      is_impulse: null,
      expense_date: { gte: cutoff },
    },
    orderBy: { amount: 'desc' },
    take: 10,
    include: { categories: { select: { name: true, icon: true } } },
  });
}

// Triage an expense (set is_impulse + optional category)
async function triageExpense(expenseId, userId, isImpulse, categorySlug) {
  const data = { is_impulse: isImpulse };
  if (categorySlug) {
    data.category_id = await resolveCategoryId(categorySlug);
  }
  return prisma.expense.update({
    where: { id: expenseId, user_id: userId },
    data,
    include: { categories: { select: { name: true, icon: true, color: true } } },
  });
}

// Aggregate spending: total, by category, impulse breakdown
async function getSpendingSummary(userId, period, localDate) {
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

  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T23:59:59Z');

  const [totalRow, byCategory, impulseRow] = await Promise.all([
    prisma.expense.aggregate({ where: { user_id: userId, expense_date: { gte: start, lte: end } }, _sum: { amount: true } }),
    prisma.expense.groupBy({
      by: ['category_id'],
      where: { user_id: userId, expense_date: { gte: start, lte: end }, category_id: { not: null } },
      _sum: { amount: true },
      _count: true,
      orderBy: { _sum: { amount: 'desc' } },
    }),
    prisma.expense.findMany({
      where: { user_id: userId, expense_date: { gte: start, lte: end } },
      select: { amount: true, is_impulse: true, source: true },
    }),
  ]);

  const total = parseFloat(totalRow._sum.amount || 0);
  const imp = impulseRow;

  let impulse_total = 0, planned_total = 0, untriaged_total = 0;
  let impulse_count = 0, untriaged_count = 0;
  for (const e of imp) {
    if (e.is_impulse === true) { impulse_total += parseFloat(e.amount); impulse_count++; }
    else if (e.is_impulse === false) { planned_total += parseFloat(e.amount); }
    else if (e.source === 'plaid') { untriaged_total += parseFloat(e.amount); untriaged_count++; }
  }

  // Resolve category names
  const catIds = byCategory.map(b => b.category_id).filter(Boolean);
  const cats = catIds.length ? await prisma.categories.findMany({ where: { id: { in: catIds } } }) : [];
  const catById = {};
  for (const c of cats) catById[c.id] = c;

  const byCategoryNamed = byCategory.map(b => ({
    category_name: catById[b.category_id]?.name || 'Other',
    category_icon: catById[b.category_id]?.icon || '📦',
    total: parseFloat(b._sum.amount || 0),
    count: b._count,
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
async function getTodaySpend(userId, localDate) {
  const today = localDate || new Date().toISOString().split('T')[0];
  const start = new Date(today + 'T00:00:00Z');
  const end = new Date(today + 'T23:59:59Z');

  const expenses = await prisma.expense.findMany({
    where: { user_id: userId, expense_date: { gte: start, lte: end } },
    select: { amount: true, is_impulse: true, source: true },
  });

  let total = 0, impulse = 0, planned = 0, untriaged = 0;
  for (const e of expenses) {
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
async function countPendingReview(userId) {
  return prisma.plaid_transaction.count({
    where: { user_id: userId, is_confirmed: false, is_pending: false },
  });
}

// Fetch unconfirmed Plaid transactions for review (with category + account info)
async function getPendingTransactions(userId) {
  return prisma.plaid_transaction.findMany({
    where: { user_id: userId, is_confirmed: false, is_pending: false },
    orderBy: [{ transaction_date: 'desc' }, { created_at: 'desc' }],
    take: 50,
    include: {
      categories: { select: { name: true, icon: true, color: true } },
      plaid_account: { select: { name: true, mask: true } },
    },
  });
}

// Confirm a Plaid transaction → create expense
async function confirmTransaction(plaidTxId, userId) {
  const tx = await prisma.plaid_transaction.findFirst({
    where: { id: plaidTxId, user_id: userId, is_confirmed: false },
    include: { categories: { select: { name: true } } },
  });
  if (!tx) return null;

  const expense = await prisma.expense.create({
    data: {
      user_id: userId,
      amount: parseFloat(tx.amount),
      description: tx.description || tx.merchant_name || 'Unknown',
      category_id: tx.category_id,
      expense_date: tx.transaction_date ? new Date(tx.transaction_date + 'T00:00:00Z') : new Date(),
      source: 'plaid',
      plaid_transaction_id: tx.transaction_id,
    },
  });

  await prisma.plaid_transaction.update({
    where: { id: plaidTxId },
    data: { is_confirmed: true, expense_id: expense.id, updated_at: new Date() },
  });

  return { expenseId: expense.id, tx };
}

// Dismiss a transaction (mark confirmed without creating expense)
async function dismissTransaction(plaidTxId, userId) {
  const count = await prisma.plaid_transaction.count({ where: { id: plaidTxId, user_id: userId } });
  if (count === 0) return false;
  await prisma.plaid_transaction.update({
    where: { id: plaidTxId },
    data: { is_confirmed: true, updated_at: new Date() },
  });
  return true;
}

// Update category on unconfirmed transaction
async function recategorizeTransaction(plaidTxId, userId, categorySlug) {
  const categoryId = await resolveCategoryId(categorySlug);
  const count = await prisma.plaid_transaction.count({ where: { id: plaidTxId, user_id: userId } });
  if (count === 0) return false;
  await prisma.plaid_transaction.update({
    where: { id: plaidTxId },
    data: { category_id: categoryId, updated_at: new Date() },
  });
  return true;
}

// Get Plaid items with accounts for a user (for Account Summary card)
async function getPlaidItemsWithAccounts(userId) {
  const items = await prisma.plaid_item.findMany({
    where: { user_id: userId },
    include: {
      plaid_accounts: {
        select: { id: true, name: true, type: true, subtype: true, mask: true },
      },
    },
    orderBy: { created_at: 'desc' },
  });
  return items;
}

// Upsert a plaid_item (called after token exchange)
async function upsertPlaidItem(userId, encryptedAccessToken, itemId, institutionName, institutionId) {
  return prisma.plaid_item.create({
    data: {
      user_id: userId,
      access_token: encryptedAccessToken,
      item_id: itemId,
      institution_name: institutionName || 'Unknown Bank',
      institution_id: institutionId || null,
    },
  });
}

// Delete a plaid_item (disconnect)
async function deletePlaidItem(itemId, userId) {
  await prisma.plaid_item.deleteMany({ where: { id: itemId, user_id: userId } });
}

// Update item cursor after sync
async function updateItemCursor(itemId, cursor) {
  await prisma.plaid_item.update({ where: { id: itemId }, data: { cursor, last_synced_at: new Date() } });
}

// Upsert a Plaid account
async function upsertPlaidAccount(plaidItemId, userId, accountId, name, officialName, type, subtype, mask) {
  return prisma.plaid_account.upsert({
    where: { account_id: accountId },
    create: { plaid_item_id: plaidItemId, user_id: userId, account_id: accountId, name, official_name: officialName, type, subtype, mask },
    update: { name, mask },
  });
}

// Get account_id → db id map for a plaid_item
async function getAccountMap(plaidItemId) {
  const accounts = await prisma.plaid_account.findMany({ where: { plaid_item_id: plaidItemId }, select: { id: true, account_id: true } });
  const map = {};
  for (const a of accounts) map[a.account_id] = a.id;
  return map;
}

// Get all categories as { name → row } map
async function getCategoriesMap() {
  const cats = await prisma.categories.findMany({ select: { id: true, name: true } });
  const map = {};
  for (const c of cats) map[c.name.toLowerCase()] = c;
  return map;
}

// Insert a Plaid transaction (dedup by transaction_id)
async function insertPlaidTransaction(params) {
  const { plaidAccountId, userId, transactionId, amount, description, merchantName, categoryId, plaidCategory, transactionDate, isPending } = params;
  return prisma.plaid_transaction.create({
    data: {
      plaid_account_id: plaidAccountId,
      user_id: userId,
      transaction_id: transactionId,
      amount: parseFloat(amount),
      description,
      merchant_name: merchantName || null,
      category_id: categoryId,
      plaid_category: plaidCategory,
      transaction_date: transactionDate ? new Date(transactionDate + 'T00:00:00Z') : null,
      is_pending: isPending || false,
    },
  }).catch(() => null); // silently ignore duplicates
}

// Get unconfirmed Plaid transactions for a user (for sync)
async function getUnconfirmedPlaidTransactions(userId) {
  return prisma.plaid_transaction.findMany({
    where: { user_id: userId, is_confirmed: false, is_pending: false },
    select: { id: true, transaction_id: true, transaction_date: true },
  });
}

// Bulk update plaid_transactions (mark confirmed or update category)
async function markTransactionsConfirmed(plaidTxIds, expenseIds) {
  // Each index corresponds; batch update
  for (let i = 0; i < plaidTxIds.length; i++) {
    await prisma.plaid_transaction.update({
      where: { id: plaidTxIds[i] },
      data: { is_confirmed: true, expense_id: expenseIds[i], updated_at: new Date() },
    });
  }
}

// Bill preferences
async function getBillPreferences(userId) {
  return prisma.bill_preferences.findMany({
    where: { user_id: userId },
    orderBy: { merchant_display_name: 'asc' },
  });
}

async function upsertBillPreference(userId, merchantKey, isDisabled, merchantDisplayName, billType) {
  return prisma.bill_preferences.upsert({
    where: { user_id_merchant_key: { user_id: userId, merchant_key: merchantKey } },
    create: { user_id: userId, merchant_key: merchantKey, is_disabled: isDisabled, merchant_display_name: merchantDisplayName, bill_type: billType },
    update: { is_disabled: isDisabled, updated_at: new Date() },
  });
}

async function trackBillMerchant(userId, merchantKey, merchantDisplayName, billType) {
  return prisma.bill_preferences.upsert({
    where: { user_id_merchant_key: { user_id: userId, merchant_key: merchantKey } },
    create: { user_id: userId, merchant_key: merchantKey, merchant_display_name: merchantDisplayName, bill_type: billType },
    update: { merchant_display_name: merchantDisplayName, bill_type: billType, updated_at: new Date() },
  });
}

async function getDisabledMerchantKeys(userId) {
  const prefs = await prisma.bill_preferences.findMany({
    where: { user_id: userId, is_disabled: true },
    select: { merchant_key: true },
  });
  return new Set(prefs.map(p => p.merchant_key));
}

// ── Spending aggregates ───────────────────────────────────────────────────────

async function getAggregateData(userId, from, to) {
  const start = from ? new Date(from + 'T00:00:00Z') : new Date(getWeekBounds().weekStart + 'T00:00:00Z');
  const end = to ? new Date(to + 'T23:59:59Z') : new Date();

  const [totalRow, byCategory] = await Promise.all([
    prisma.expense.aggregate({
      where: { user_id: userId, expense_date: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.expense.groupBy({
      by: ['category_id'],
      where: { user_id: userId, expense_date: { gte: start, lte: end }, category_id: { not: null } },
      _sum: { amount: true },
      _count: true,
      orderBy: { _sum: { amount: 'desc' } },
    }),
  ]);

  const catIds = byCategory.map(b => b.category_id).filter(Boolean);
  const cats = catIds.length ? await prisma.categories.findMany({ where: { id: { in: catIds } } }) : [];
  const catById = {};
  for (const c of cats) catById[c.id] = c;

  const by_category = byCategory.map(b => ({
    category: catById[b.category_id]?.name || 'Other',
    category_icon: catById[b.category_id]?.icon || '📦',
    total: (parseFloat(b._sum.amount || 0) * 100).toFixed(0), // return as cents for compat
    count: b._count,
  }));

  return {
    total_spend: parseFloat(totalRow._sum.amount || 0) * 100, // cents
    by_category,
  };
}

async function getSpendingStatsData(userId) {
  const all = await prisma.expense.findMany({
    where: { user_id: userId, is_impulse: { not: null } },
    select: { is_impulse: true },
  });

  const total_classified = all.length;
  const impulse_count = all.filter(e => e.is_impulse === true).length;
  const planned_count = all.filter(e => e.is_impulse === false).length;

  return { total_classified, impulse_count, planned_count };
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
};