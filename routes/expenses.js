// routes/expenses.js — Manual quick-add + Plaid auto-categorization + impulse triage API.
// Owns: /api/expenses/* endpoints.
// Does NOT own: Plaid sync logic (routes/plaid.js), raw expense SQL (db/expenses.js).

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const {
  VALID_CATEGORIES,
  plaidCategoryToSlug,
  createExpense,
  importPlaidExpense,
  getExpenses,
  getUntriagedExpenses,
  triageExpense,
  getSpendingSummary,
  getTodaySpend,
} = require('../db/expenses');
const { insertEvent } = require('../db/events');
// impulse nudge engine used by the alerts endpoint; reflection/delay handled client-side


module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ── GET /api/expenses/categories ────────────────────────────────────────────
  // Returns the 10 FocusLedger category slugs with emoji labels
  router.get('/categories', async (req, res) => {
    try {
      const categories = Object.entries(VALID_CATEGORIES).map(([slug, label]) => ({
        slug, label
      }));
      res.json({ success: true, categories });
    } catch (err) {
      console.error('[Expenses] Error fetching categories:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
  });

  // ── GET /api/expenses/budget ─────────────────────────────────────────────────
  router.get('/budget', async (req, res) => {
    try {
      const userId = req.user.id;
      const budget = await pool.query(
        'SELECT * FROM budgets WHERE is_active = true AND user_id = $1 LIMIT 1',
        [userId]
      );
      if (budget.rows.length === 0) {
        return res.json({ success: true, budget: { weekly_amount: 500 } });
      }

      const tz = await fetchUserTimezone(pool, userId);
      const { weekStart, weekEnd } = getWeekBounds(getUserLocalDate(tz));
      const spent = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_spent
         FROM expenses
         WHERE expense_date >= $1 AND expense_date <= $2 AND user_id = $3`,
        [weekStart, weekEnd, userId]
      );

      const weeklyAmount = parseFloat(budget.rows[0].weekly_amount);
      const totalSpent = parseFloat(spent.rows[0].total_spent);
      res.json({
        success: true,
        budget: {
          ...budget.rows[0],
          weekly_amount: weeklyAmount,
          total_spent: totalSpent,
          remaining: weeklyAmount - totalSpent,
          week_start: weekStart,
          week_end: weekEnd,
        }
      });
    } catch (err) {
      console.error('[Expenses] Error fetching budget:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch budget' });
    }
  });

  // ── PUT /api/expenses/budget ─────────────────────────────────────────────────
  router.put('/budget', async (req, res) => {
    try {
      const { weekly_amount } = req.body;
      const userId = req.user.id;

      if (!weekly_amount || weekly_amount <= 0) {
        return res.status(400).json({ success: false, message: 'Valid weekly amount required' });
      }

      const existing = await pool.query(
        'SELECT id FROM budgets WHERE is_active = true AND user_id = $1 LIMIT 1',
        [userId]
      );
      let result;
      if (existing.rows.length > 0) {
        result = await pool.query(
          'UPDATE budgets SET weekly_amount = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
          [weekly_amount, existing.rows[0].id]
        );
      } else {
        result = await pool.query(
          'INSERT INTO budgets (weekly_amount, user_id) VALUES ($1, $2) RETURNING *',
          [weekly_amount, userId]
        );
      }
      res.json({ success: true, budget: result.rows[0] });
    } catch (err) {
      console.error('[Expenses] Error updating budget:', err);
      res.status(500).json({ success: false, message: 'Failed to update budget' });
    }
  });

  // ── GET /api/expenses/summary ────────────────────────────────────────────────
  router.get('/summary', async (req, res) => {
    try {
      const userId = req.user.id;
      const period = req.query.period || 'week';
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);
      const summary = await getSpendingSummary(pool, userId, period, localDate);
      res.json({ success: true, summary });
    } catch (err) {
      console.error('[Expenses] Error fetching summary:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch summary' });
    }
  });

  // ── GET /api/expenses/today ──────────────────────────────────────────────────
  router.get('/today', async (req, res) => {
    try {
      const tz = await fetchUserTimezone(pool, req.user.id);
      const localDate = getUserLocalDate(tz);
      const spend = await getTodaySpend(pool, req.user.id, localDate);
      res.json({ success: true, ...spend });
    } catch (err) {
      console.error('[Expenses] Error fetching today spend:', err);
      res.status(500).json({ success: false, message: 'Failed' });
    }
  });

  // ── GET /api/expenses/untriaged ──────────────────────────────────────────────
  // Returns Plaid expenses from last 7 days where is_impulse IS NULL
  router.get('/untriaged', async (req, res) => {
    try {
      const tz = await fetchUserTimezone(pool, req.user.id);
      const localDate = getUserLocalDate(tz);
      const expenses = await getUntriagedExpenses(pool, req.user.id, localDate);
      res.json({ success: true, expenses, count: expenses.length });
    } catch (err) {
      console.error('[Expenses] Error fetching untriaged:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch untriaged expenses' });
    }
  });

  // ── GET /api/expenses ────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const { period } = req.query;
      const tz = await fetchUserTimezone(pool, req.user.id);
      const localDate = getUserLocalDate(tz);
      const expenses = await getExpenses(pool, req.user.id, period || 'week', localDate);
      res.json({ success: true, expenses });
    } catch (err) {
      console.error('[Expenses] Error fetching expenses:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch expenses' });
    }
  });

  // ── POST /api/expenses ───────────────────────────────────────────────────────
  // Manual quick-add: { amount, category, is_impulse, note, expense_date }
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { amount, category, is_impulse, note, expense_date } = req.body;

      if (!amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'Valid amount required' });
      }

      // Validate category slug if provided
      const categorySlug = (category && VALID_CATEGORIES[category]) ? category : 'other';

      // is_impulse: true = impulse, false = planned, null = untriaged
      const impulseValue = is_impulse === true || is_impulse === 'true' ? true
                         : is_impulse === false || is_impulse === 'false' ? false
                         : null;

      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);
      const expense = await createExpense(pool, {
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
      console.error('[Expenses] Error creating expense:', err);
      res.status(500).json({ success: false, message: 'Failed to create expense' });
    }
  });

  // ── POST /api/expenses/import-plaid ─────────────────────────────────────────
  // Pull recent Plaid transactions for this user → store as expenses (is_impulse = NULL)
  router.post('/import-plaid', async (req, res) => {
    try {
      const userId = req.user.id;

      // Fetch plaid_items for this user
      const itemsResult = await pool.query(
        'SELECT * FROM plaid_items WHERE user_id = $1',
        [userId]
      );
      if (itemsResult.rows.length === 0) {
        return res.json({ success: true, imported: 0, message: 'No bank accounts connected' });
      }

      // Get confirmed plaid_transactions that aren't yet in expenses (dedup by plaid_transaction_id)
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);
      const txResult = await pool.query(`
        SELECT pt.transaction_id, pt.amount, pt.description, pt.merchant_name,
               pt.plaid_category, pt.transaction_date
        FROM plaid_transactions pt
        WHERE pt.user_id = $1
          AND pt.is_confirmed = false
          AND pt.is_pending = false
          AND pt.transaction_date >= $2::date - INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM expenses e
            WHERE e.plaid_transaction_id = pt.transaction_id
          )
        ORDER BY pt.transaction_date DESC
        LIMIT 50
      `, [userId, localDate]);

      let imported = 0;
      for (const tx of txResult.rows) {
        const slug = plaidCategoryToSlug(tx.plaid_category || '');
        const row = await importPlaidExpense(pool, {
          userId,
          amount: tx.amount,
          merchantName: tx.merchant_name || tx.description || 'Unknown',
          plaidTransactionId: tx.transaction_id,
          plaidOriginalCategory: tx.plaid_category,
          categorySlug: slug,
          transactionDate: tx.transaction_date,
        });
        if (row) imported++;
      }

      res.json({ success: true, imported, message: `${imported} transactions imported for review` });
    } catch (err) {
      console.error('[Expenses] Error importing Plaid transactions:', err);
      res.status(500).json({ success: false, message: 'Failed to import transactions' });
    }
  });

  // ── PATCH /api/expenses/:id/triage ──────────────────────────────────────────
  // { is_impulse: true|false, category?: string }
  router.patch('/:id/triage', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const { is_impulse, category } = req.body;

      if (is_impulse === undefined || is_impulse === null) {
        return res.status(400).json({ success: false, message: 'is_impulse required' });
      }

      const impulseValue = is_impulse === true || is_impulse === 'true' ? true : false;
      const categorySlug = (category && VALID_CATEGORIES[category]) ? category : null;

      const expense = await triageExpense(pool, parseInt(id), userId, impulseValue, categorySlug);
      if (!expense) {
        return res.status(404).json({ success: false, message: 'Expense not found' });
      }

      // Emit transaction.classified event
      insertEvent(pool, { userId, eventType: 'transaction.classified', payload: { expense_id: expense.id, classification: impulseValue ? 'impulse' : 'planned', category: categorySlug } }).catch(e =>
        console.warn('[Expenses] Event log error:', e.message)
      );

      res.json({ success: true, expense });
    } catch (err) {
      console.error('[Expenses] Error triaging expense:', err);
      res.status(500).json({ success: false, message: 'Failed to triage expense' });
    }
  });

  // ── PATCH /api/expenses/:id ──────────────────────────────────────────────────
  // Generic update (value_id, etc.) — preserved for backward compat
  router.patch('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { value_id, is_impulse, category } = req.body;
      const userId = req.user.id;

      // If triage fields present, delegate to triage logic
      if (is_impulse !== undefined) {
        const impulseValue = is_impulse === true || is_impulse === 'true' ? true : false;
        const categorySlug = (category && VALID_CATEGORIES[category]) ? category : null;
        const expense = await triageExpense(pool, parseInt(id), userId, impulseValue, categorySlug);
        if (!expense) {
          return res.status(404).json({ success: false, message: 'Expense not found' });
        }
        // Emit transaction.classified event
        insertEvent(pool, { userId, eventType: 'transaction.classified', payload: { expense_id: expense.id, classification: impulseValue ? 'impulse' : 'planned', category: categorySlug } }).catch(e =>
          console.warn('[Expenses] Event log error:', e.message)
        );
        return res.json({ success: true, expense });
      }

      if (value_id === undefined) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      const resolvedValueId = (value_id === null || value_id === 0) ? null : parseInt(value_id);
      const result = await pool.query(
        'UPDATE expenses SET value_id = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
        [resolvedValueId, id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Expense not found' });
      }
      res.json({ success: true, expense: result.rows[0] });
    } catch (err) {
      console.error('[Expenses] Error updating expense:', err);
      res.status(500).json({ success: false, message: 'Failed to update expense' });
    }
  });

  // ── GET /api/expenses/alerts ────────────────────────────────────────────────
  // Returns active spending pattern alerts + reflection card config
  router.get('/alerts', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);

      const { getActiveAlerts, getWeeklySpendingStats } = require('../db/impulseNudges');
      const { buildSpendingAlert } = require('../lib/impulseNudgeEngine');

      const [alerts, stats] = await Promise.all([
        getActiveAlerts(pool, userId),
        getWeeklySpendingStats(pool, userId, localDate),
      ]);

      // Generate a new alert if patterns warrant it (not already dismissed today)
      const newAlert = buildSpendingAlert(stats);

      res.json({
        success: true,
        alerts: alerts.map(a => ({ id: a.id, alert_type: a.alert_type, message: a.message })),
        pendingAlert: newAlert,
        stats: { total_spent: stats.total_spent, impulse_count: stats.impulse_count },
      });
    } catch (err) {
      console.error('[Expenses] Error fetching alerts:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch alerts' });
    }
  });

  // ── GET /api/expenses/nudge-config ───────────────────────────────────────────
  // Returns impulse nudge settings (thresholds for reflection card, delay prompt)
  router.get('/nudge-config', async (req, res) => {
    res.json({
      success: true,
      delayThreshold: 75,    // show 10-min countdown for purchases >= $75
      reflectionMin:  25,    // show reflection card for purchases >= $25
      highSpendThreshold: 400, // trigger weekly spend alert if over this
    });
  });

  // ── DELETE /api/expenses/alerts/:id ─────────────────────────────────────────
  // Dismiss a spending alert
  router.delete('/alerts/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const { getActiveAlerts, dismissAlert } = require('../db/impulseNudges');

      const alerts = await getActiveAlerts(pool, userId);
      const alert = alerts.find(a => a.id === parseInt(req.params.id));
      if (!alert) {
        return res.status(404).json({ success: false, message: 'Alert not found' });
      }

      await dismissAlert(pool, parseInt(req.params.id), userId);
      res.json({ success: true });
    } catch (err) {
      console.error('[Expenses] Error dismissing alert:', err);
      res.status(500).json({ success: false, message: 'Failed to dismiss alert' });
    }
  });

  // ── DELETE /api/expenses/:id ─────────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      const result = await pool.query(
        'DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Expense not found' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[Expenses] Error deleting expense:', err);
      res.status(500).json({ success: false, message: 'Failed to delete expense' });
    }
  });

  return router;
};

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * @param {string} [localDate] — YYYY-MM-DD in user's timezone
 */
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
