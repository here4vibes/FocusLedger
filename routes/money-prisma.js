// Phase 3B: Money tab CRUD backed by Prisma.
// Owns: expense CRUD, Plaid transaction review, Account Summary, spending aggregates.
// Does NOT own: Plaid Link setup (routes/plaid.js), auth middleware beyond session/JWT support.
const { prisma } = require('../lib/prisma');
const _proUtils = require('../middleware/proUtils');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const {
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
  deletePlaidItem,
  getBillPreferences,
  upsertBillPreference,
  getAggregateData,
  getSpendingStatsData,
} = require('../db/money-prisma');

// ── Auth middleware (use both session + JWT) ──────────────────────────────────
function authMW(req, res, next) {
  if (req.session?.user) { req.user = req.session.user; return next(); }
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    const { verifyToken } = require('../middleware/auth');
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ── Valid FocusLedger slugs ───────────────────────────────────────────────────
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

// ── GET /api/money/expenses/categories ───────────────────────────────────
async function getCategories(req, res) {
  const cats = Object.entries(VALID_CATEGORIES).map(([slug, label]) => ({ slug, label }));
  res.json({ success: true, categories: cats });
}

// ── GET /api/money/expenses/summary ────────────────────────────────────────
async function getSummary(req, res) {
  try {
    const userId = req.user.id;
    const period = req.query.period || 'week';
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localDate = getUserLocalDate(tz);
    const summary = await getSpendingSummary(userId, period, localDate);
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[money-prisma] summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch summary' });
  }
}

// ── GET /api/money/expenses/today ───────────────────────────────────────────
async function getToday(req, res) {
  try {
    const userId = req.user.id;
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localDate = getUserLocalDate(tz);
    const spend = await getTodaySpend(userId, localDate);
    res.json({ success: true, ...spend });
  } catch (err) {
    console.error('[money-prisma] today error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch today spend' });
  }
}

// ── GET /api/money/expenses/untriaged ───────────────────────────────────────
async function getUntriaged(req, res) {
  try {
    const userId = req.user.id;
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localDate = getUserLocalDate(tz);
    const expenses = await getUntriagedExpenses(userId, localDate);
    res.json({ success: true, expenses, count: expenses.length });
  } catch (err) {
    console.error('[money-prisma] untriaged error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch untriaged' });
  }
}

// ── GET /api/money/expenses ────────────────────────────────────────────────
async function listExpenses(req, res) {
  try {
    const userId = req.user.id;
    const period = req.query.period || 'week';
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localDate = getUserLocalDate(tz);
    const expenses = await getExpenses(userId, period, localDate);
    res.json({ success: true, expenses });
  } catch (err) {
    console.error('[money-prisma] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch expenses' });
  }
}

// ── POST /api/money/expenses ───────────────────────────────────────────────
async function addExpense(req, res) {
  try {
    const userId = req.user.id;
    const { amount, category, is_impulse, note, expense_date } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    const categorySlug = (category && VALID_CATEGORIES[category]) ? category : 'other';
    const impulseValue = is_impulse === true || is_impulse === 'true' ? true
                       : is_impulse === false || is_impulse === 'false' ? false
                       : null;

    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localDate = getUserLocalDate(tz);
    const expense = await createExpense({
      userId,
      amount: parseFloat(amount),
      categorySlug,
      isImpulse: impulseValue,
      note: note || null,
      expenseDate: expense_date || null,
      localDate,
    });

    res.status(201).json({ success: true, expense });
  } catch (err) {
    console.error('[money-prisma] create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create expense' });
  }
}

// ── PATCH /api/money/expenses/:id/triage ─────────────────────────────────
async function patchTriage(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { is_impulse, category } = req.body;

    if (is_impulse === undefined || is_impulse === null) {
      return res.status(400).json({ success: false, message: 'is_impulse required' });
    }

    const impulseValue = is_impulse === true || is_impulse === 'true';
    const categorySlug = (category && VALID_CATEGORIES[category]) ? category : null;

    const expense = await triageExpense(parseInt(id), userId, impulseValue, categorySlug);
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });

    res.json({ success: true, expense });
  } catch (err) {
    // PrismaClientKnownRequestError code P2025 = Record not found
    if (err?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    console.error('[money-prisma] triage error:', err);
    res.status(500).json({ success: false, message: 'Failed to triage expense' });
  }
}

// ── PATCH /api/money/expenses/:id ─────────────────────────────────────────
async function updateExpense(req, res) {
  try {
    const { id } = req.params;
    const { is_impulse, category } = req.body;
    const userId = req.user.id;

    if (is_impulse !== undefined) {
      const impulseValue = is_impulse === true || is_impulse === 'true';
      const categorySlug = (category && VALID_CATEGORIES[category]) ? category : null;
      const expense = await triageExpense(parseInt(id), userId, impulseValue, categorySlug);
      if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
      return res.json({ success: true, expense });
    }

    res.status(400).json({ success: false, message: 'No fields to update' });
  } catch (err) {
    if (err?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }
    console.error('[money-prisma] update error:', err);
    res.status(500).json({ success: false, message: 'Failed to update expense' });
  }
}

// ── DELETE /api/money/expenses/:id ────────────────────────────────────────
async function deleteExpense(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    await prisma.expense.deleteMany({ where: { id: parseInt(id), user_id: userId } });
    res.json({ success: true });
  } catch (err) {
    console.error('[money-prisma] delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete expense' });
  }
}

// ── GET /api/money/nudge-config ────────────────────────────────────────────
async function getNudgeConfig(req, res) {
  res.json({ success: true, delayThreshold: 75, reflectionMin: 25, highSpendThreshold: 400 });
}

// ── GET /api/money/transactions/aggregate ───────────────────────────────
// Used by: This Week card, Top Categories card
// Returns: { total_spend, by_category } for the given date range
async function getAggregate(req, res) {
  try {
    const { from, to } = req.query;
    const userId = req.user.id;
    const aggregate = await getAggregateData(userId, from, to);
    res.json({ ...aggregate });
  } catch (err) {
    console.error('[money-prisma] aggregate error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch aggregate' });
  }
}

// ── GET /api/money/spending-sessions/today ─────────────────────────────
// Used by: evening swipe completion check in money.html
// Returns: { success, session: { complete } }
async function getTodaySession(req, res) {
  try {
    const userId = req.user.id;
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const today = getUserLocalDate(tz);
    const todayStart = new Date(today + 'T00:00:00Z');
    const todayEnd = new Date(today + 'T23:59:59Z');

    const sessions = await prisma.spending_session.findMany({
      where: { user_id: userId, started_at: { gte: todayStart, lte: todayEnd } },
      orderBy: { started_at: 'desc' },
      take: 1,
    });

    const session = sessions[0] || null;
    res.json({
      success: true,
      session: session ? {
        id: session.id,
        started_at: session.started_at,
        ended_at: session.ended_at,
        planned_count: session.planned_count,
        impulse_count: session.impulse_count,
        complete: !!session.ended_at,
      } : null,
    });
  } catch (err) {
    console.error('[money-prisma] today session error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch today session' });
  }
}

// ── GET /api/money/spending-sessions/stats ──────────────────────────────
// Used by: Impulse vs Planned card
// Returns: { total_classified, impulse_count, planned_count }
async function getSpendingStats(req, res) {
  try {
    const userId = req.user.id;
    const stats = await getSpendingStatsData(userId);
    res.json({ ...stats });
  } catch (err) {
    console.error('[money-prisma] spending-stats error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch spending stats' });
  }
}

// ── GET /api/money/alerts ─────────────────────────────────────────────────
async function getAlerts(req, res) {
  try {
    res.json({ success: true, alerts: [], pendingAlert: null, stats: { total_spent: 0, impulse_count: 0 } });
  } catch (err) {
    console.error('[money-prisma] alerts error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch alerts' });
  }
}

// ── GET /api/money/transactions/pending ───────────────────────────────────
async function getPending(req, res) {
  try {
    const userId = req.user.id;
    const txs = await getPendingTransactions(userId);
    res.json({ success: true, transactions: txs });
  } catch (err) {
    console.error('[money-prisma] pending error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch pending' });
  }
}

// ── PATCH /api/money/transactions/:id/category ────────────────────────────
async function recategorize(req, res) {
  try {
    const { id } = req.params;
    const { category_name } = req.body;
    const userId = req.user.id;

    if (!category_name) return res.status(400).json({ success: false, message: 'category_name required' });

    // Map category name to slug
    const slug = category_name.toLowerCase().replace(/[&]/g, '').replace(/ /g, '_').replace(/_+/g, '_');
    const validSlug = VALID_CATEGORIES[slug] ? slug : 'other';
    const updated = await recategorizeTransaction(parseInt(id), userId, validSlug);
    if (!updated) return res.status(404).json({ success: false, message: 'Transaction not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('[money-prisma] recategorize error:', err);
    res.status(500).json({ success: false, message: 'Failed to update category' });
  }
}

// ── POST /api/money/transactions/:id/confirm ───────────────────────────────
async function confirmTx(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const result = await confirmTransaction(parseInt(id), userId);
    if (!result) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true, expense_id: result.expenseId });
  } catch (err) {
    console.error('[money-prisma] confirm error:', err);
    res.status(500).json({ success: false, message: 'Failed to confirm transaction' });
  }
}

// ── POST /api/money/transactions/:id/dismiss ──────────────────────────────
async function dismissTx(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const dismissed = await dismissTransaction(parseInt(id), userId);
    if (!dismissed) return res.status(404).json({ success: false, message: 'Transaction not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[money-prisma] dismiss error:', err);
    res.status(500).json({ success: false, message: 'Failed to dismiss transaction' });
  }
}

// ── GET /api/money/accounts ────────────────────────────────────────────────
// Used by Account Summary card — returns Plaid accounts with balances
async function getAccounts(req, res) {
  try {
    const userId = req.user.id;
    const items = await getPlaidItemsWithAccounts(userId);
    const pendingCount = await countPendingReview(userId);

    if (items.length === 0) {
      return res.json({ connected: false });
    }

    // For each item, attempt to fetch balances from Plaid
    // (stored encrypted tokens — no balance in DB directly)
    // Return account list + last synced time
    const resultItems = items.map(item => ({
      id: item.id,
      institution: item.institution_name,
      institution_id: item.institution_id,
      lastSynced: item.last_synced_at,
      accounts: item.plaid_accounts.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask,
        // Balance is fetched live from Plaid — stored accounts have no balance column
      })),
    }));

    res.json({
      connected: true,
      items: resultItems,
      pending_review_count: pendingCount,
    });
  } catch (err) {
    console.error('[money-prisma] accounts error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch accounts' });
  }
}

// ── DELETE /api/money/items/:id ────────────────────────────────────────────
// Disconnect a Plaid item
async function disconnectItem(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    await deletePlaidItem(parseInt(id), userId);
    res.json({ success: true, message: 'Account disconnected.' });
  } catch (err) {
    console.error('[money-prisma] disconnect error:', err);
    res.status(500).json({ success: false, message: 'Failed to disconnect' });
  }
}

// ── GET /api/money/bills ─────────────────────────────────────────────────
async function getBills(req, res) {
  try {
    const userId = req.user.id;
    const bills = await getBillPreferences(userId);
    res.json({ success: true, bills });
  } catch (err) {
    console.error('[money-prisma] bills error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch bills' });
  }
}

// ── POST /api/money/bills/:key/disable ────────────────────────────────────
async function disableBill(req, res) {
  try {
    const { key } = req.params;
    const userId = req.user.id;
    await upsertBillPreference(userId, key, true, null, null);
    res.json({ success: true, message: 'Auto-tasks disabled' });
  } catch (err) {
    console.error('[money-prisma] disable bill error:', err);
    res.status(500).json({ success: false, message: 'Failed to disable bill' });
  }
}

// ── POST /api/money/bills/:key/enable ────────────────────────────────────
async function enableBill(req, res) {
  try {
    const { key } = req.params;
    const userId = req.user.id;
    await upsertBillPreference(userId, key, false, null, null);
    res.json({ success: true, message: 'Auto-tasks re-enabled' });
  } catch (err) {
    console.error('[money-prisma] enable bill error:', err);
    res.status(500).json({ success: false, message: 'Failed to enable bill' });
  }
}

// ── Mount on Express Router ───────────────────────────────────────────────
module.exports = function() {
  const router = require('express').Router();
  router.use(authMW);

  // Expense CRUD
  router.get('/expenses/categories',  getCategories);
  router.get('/expenses/summary',     getSummary);
  router.get('/expenses/today',        getToday);
  router.get('/expenses/untriaged',   getUntriaged);
  router.get('/expenses',             listExpenses);
  router.post('/expenses',            addExpense);
  router.patch('/expenses/:id/triage', patchTriage);
  router.patch('/expenses/:id',       updateExpense);
  router.delete('/expenses/:id',      deleteExpense);

  // Spending aggregates (used by dashboard cards)
  router.get('/transactions/aggregate', getAggregate);

  // Spending sessions stats (impulse vs planned breakdown)
  router.get('/spending-sessions/stats', getSpendingStats);

  // Get today's spending session (used by dashboard unlock conditions)
  router.get('/spending-sessions/today', getTodaySession);

  // Nudge config + alerts
  router.get('/nudge-config',  getNudgeConfig);
  router.get('/alerts',         getAlerts);

  // Plaid transaction review
  router.get('/transactions/pending',  getPending);
  router.patch('/transactions/:id/category', recategorize);
  router.post('/transactions/:id/confirm',  confirmTx);
  router.post('/transactions/:id/dismiss',   dismissTx);

  // Accounts + bills
  router.get('/accounts',     getAccounts);
  router.delete('/items/:id', disconnectItem);
  router.get('/bills',         getBills);
  router.post('/bills/:key/disable', disableBill);
  router.post('/bills/:key/enable',   enableBill);

  return router;
};