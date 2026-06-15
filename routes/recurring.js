const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {

  // All recurring routes require authentication
  router.use(authenticateToken);

  // ============================================================
  // HELPER: Calculate next occurrence date
  // ============================================================
  function calculateNextDate(fromDate, frequency) {
    // fromDate might be a string like "2025-01-15" — parse as local date to avoid UTC offset issues
    // Normalize to YYYY-MM-DD — handles both string and Date inputs
    const dateStr = (fromDate instanceof Date)
      ? fromDate.toISOString().split('T')[0]
      : String(fromDate).split('T')[0];
    const [year, month, day] = dateStr.split('-').map(Number);
    const base = new Date(year, month - 1, day);

    switch (frequency) {
      case 'daily':
        base.setDate(base.getDate() + 1);
        break;
      case 'weekly':
        base.setDate(base.getDate() + 7);
        break;
      case 'biweekly':
        base.setDate(base.getDate() + 14);
        break;
      case 'monthly':
        base.setMonth(base.getMonth() + 1);
        break;
      case 'quarterly':
        base.setMonth(base.getMonth() + 3);
        break;
      case 'yearly':
        base.setFullYear(base.getFullYear() + 1);
        break;
      default:
        base.setDate(base.getDate() + 7);
    }

    // Return as YYYY-MM-DD string
    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, '0');
    const dd = String(base.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  // WHY: removed hardcoded server-time todayStr(). Now uses getUserLocalDate(tz)
  // from lib/timezone.js so "today" respects the user's stored timezone.
  // Each call site fetches the user's timezone and passes it through.

  async function isPro(userId) {
    try {
      return await checkProStatus(pool, userId);
    } catch (e) {
      console.error('[Recurring] Pro check failed:', e.message);
      // Fail closed: if Pro check fails, deny recurring feature (requires Pro)
      return false;
    }
  }

  // ============================================================
  // RECURRING TASKS
  // ============================================================

  // GET /api/recurring/tasks — list all recurring task schedules
  router.get('/tasks', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(`
        SELECT rt.*,
          (SELECT COUNT(*) FROM tasks t WHERE t.recurring_task_id = rt.id AND t.is_completed = false) as active_count
        FROM recurring_tasks rt
        WHERE rt.user_id = $1
        ORDER BY rt.created_at DESC
      `, [userId]);
      res.json({ success: true, recurring_tasks: result.rows });
    } catch (err) {
      console.error('Error fetching recurring tasks:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch recurring tasks' });
    }
  });

  // POST /api/recurring/tasks — create a recurring task + first instance
  router.post('/tasks', async (req, res) => {
    try {
      const { title, description, priority, frequency, start_date } = req.body;
      const userId = req.user.id;

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Title is required' });
      }
      const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
      if (!validFrequencies.includes(frequency)) {
        return res.status(400).json({ success: false, message: 'Invalid frequency' });
      }

      const today = await fetchUserLocalDate(pool, userId);
      const firstDate = start_date || today;

      // Check Pro status before transaction — uses checkIsPro which respects admin_pro_override
      const userIsPro = await isPro(userId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check free-tier recurring task limit (max 2 active recurring tasks)
        if (!userIsPro) {
          const recurringCountResult = await client.query(
            'SELECT COUNT(*) as count FROM recurring_tasks WHERE user_id = $1 AND is_paused = false',
            [userId]
          );
          if (parseInt(recurringCountResult.rows[0].count) >= 2) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              success: false,
              recurring_limit_reached: true,
              message: "Free plan includes up to 2 active recurring tasks. Upgrade to Pro for unlimited recurring tasks."
            });
          }
        }

        // Create the recurring template
        const rtResult = await client.query(`
          INSERT INTO recurring_tasks (user_id, title, description, priority, frequency, start_date, next_due_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [userId, title.trim(), description || null, priority || 'medium',
            frequency, firstDate, firstDate]);
        const recurringTask = rtResult.rows[0];

        // Check task limit for free users before creating the first instance
        let canCreate = true;
        let limitMessage = null;
        if (!userIsPro) {
          const activeCount = await client.query(
            'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
            [userId]
          );
          if (parseInt(activeCount.rows[0].count) >= 10) {
            canCreate = false;
            limitMessage = 'Free plan is limited to 10 active tasks. Upgrade to Pro for unlimited tasks!';
          }
        }

        let firstTask = null;
        if (canCreate) {
          // Create the first task instance
          const taskResult = await client.query(`
            INSERT INTO tasks (user_id, title, description, priority, due_date, source, recurring_task_id)
            VALUES ($1, $2, $3, $4, $5, 'recurring', $6) RETURNING *
          `, [userId, title.trim(), description || null, priority || 'medium',
              firstDate, recurringTask.id]);
          firstTask = taskResult.rows[0];

          // Advance next_due_date past this first instance
          const nextDate = calculateNextDate(firstDate, frequency);
          await client.query(
            'UPDATE recurring_tasks SET next_due_date = $1 WHERE id = $2',
            [nextDate, recurringTask.id]
          );
          recurringTask.next_due_date = nextDate;
        }

        await client.query('COMMIT');

        res.status(201).json({
          success: true,
          recurring_task: recurringTask,
          first_task: firstTask,
          limit_reached: !canCreate,
          limit_message: limitMessage
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error creating recurring task:', err);
      res.status(500).json({ success: false, message: 'Failed to create recurring task' });
    }
  });

  // PATCH /api/recurring/tasks/:id — update (pause/resume/edit)
  router.patch('/tasks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { is_paused, frequency, title } = req.body;
      const userId = req.user.id;

      const updates = [];
      const params = [];
      let idx = 1;

      if (is_paused !== undefined) {
        updates.push(`is_paused = $${idx++}`);
        params.push(Boolean(is_paused));
      }
      if (frequency !== undefined) {
        const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
        if (!validFrequencies.includes(frequency)) {
          return res.status(400).json({ success: false, message: 'Invalid frequency' });
        }
        updates.push(`frequency = $${idx++}`);
        params.push(frequency);
      }
      if (title !== undefined && title.trim()) {
        updates.push(`title = $${idx++}`);
        params.push(title.trim());
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      params.push(id, userId);
      const result = await pool.query(
        `UPDATE recurring_tasks SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Recurring task not found' });
      }

      res.json({ success: true, recurring_task: result.rows[0] });
    } catch (err) {
      console.error('Error updating recurring task:', err);
      res.status(500).json({ success: false, message: 'Failed to update recurring task' });
    }
  });

  // DELETE /api/recurring/tasks/:id — delete the entire series
  router.delete('/tasks/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      // Verify ownership
      const check = await pool.query(
        'SELECT id FROM recurring_tasks WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Recurring task not found' });
      }

      // Unlink all task instances (don't delete them, just detach)
      await pool.query(
        'UPDATE tasks SET recurring_task_id = NULL WHERE recurring_task_id = $1',
        [id]
      );

      // Delete the recurring template
      await pool.query('DELETE FROM recurring_tasks WHERE id = $1', [id]);

      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting recurring task:', err);
      res.status(500).json({ success: false, message: 'Failed to delete recurring task' });
    }
  });

  // ============================================================
  // RECURRING EXPENSES
  // ============================================================

  // GET /api/recurring/expenses — list all recurring expense schedules
  router.get('/expenses', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(`
        SELECT re.*, c.name as category_name, c.color as category_color, c.icon as category_icon
        FROM recurring_expenses re
        LEFT JOIN categories c ON c.id = re.category_id
        WHERE re.user_id = $1
        ORDER BY re.created_at DESC
      `, [userId]);
      res.json({ success: true, recurring_expenses: result.rows });
    } catch (err) {
      console.error('Error fetching recurring expenses:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch recurring expenses' });
    }
  });

  // POST /api/recurring/expenses — create a recurring expense
  router.post('/expenses', async (req, res) => {
    try {
      const { description, amount, category_id, category, frequency, start_date } = req.body;
      const userId = req.user.id;

      if (!amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: 'Valid amount required' });
      }
      const validFrequencies = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
      if (!validFrequencies.includes(frequency)) {
        return res.status(400).json({ success: false, message: 'Invalid frequency' });
      }

      // Resolve category_id from name if needed
      let resolvedCategoryId = category_id || null;
      if (!resolvedCategoryId && category) {
        const catResult = await pool.query(
          'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
          [category]
        );
        if (catResult.rows.length > 0) {
          resolvedCategoryId = catResult.rows[0].id;
        }
      }

      const today = await fetchUserLocalDate(pool, userId);
      const firstDate = start_date || today;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create recurring template
        const reResult = await client.query(`
          INSERT INTO recurring_expenses (user_id, description, amount, category_id, frequency, start_date, next_due_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [userId, description || null, parseFloat(amount), resolvedCategoryId,
            frequency, firstDate, firstDate]);
        const recurringExpense = reResult.rows[0];

        // Create the first expense instance
        const expResult = await client.query(`
          INSERT INTO expenses (user_id, amount, description, category_id, expense_date, source, recurring_expense_id)
          VALUES ($1, $2, $3, $4, $5, 'recurring', $6) RETURNING *
        `, [userId, parseFloat(amount), description || null, resolvedCategoryId,
            firstDate, recurringExpense.id]);
        const firstExpense = expResult.rows[0];

        // Advance next_due_date
        const nextDate = calculateNextDate(firstDate, frequency);
        await client.query(
          'UPDATE recurring_expenses SET next_due_date = $1 WHERE id = $2',
          [nextDate, recurringExpense.id]
        );
        recurringExpense.next_due_date = nextDate;

        await client.query('COMMIT');

        // Fetch with category info
        const full = await pool.query(`
          SELECT e.*, c.name as category_name, c.color as category_color, c.icon as category_icon
          FROM expenses e
          LEFT JOIN categories c ON c.id = e.category_id
          WHERE e.id = $1
        `, [firstExpense.id]);

        const reWithCat = await pool.query(`
          SELECT re.*, c.name as category_name, c.color as category_color, c.icon as category_icon
          FROM recurring_expenses re
          LEFT JOIN categories c ON c.id = re.category_id
          WHERE re.id = $1
        `, [recurringExpense.id]);

        res.status(201).json({
          success: true,
          recurring_expense: reWithCat.rows[0],
          first_expense: full.rows[0]
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error creating recurring expense:', err);
      res.status(500).json({ success: false, message: 'Failed to create recurring expense' });
    }
  });

  // PATCH /api/recurring/expenses/:id — update
  router.patch('/expenses/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { is_paused, frequency, amount, description } = req.body;
      const userId = req.user.id;

      const updates = [];
      const params = [];
      let idx = 1;

      if (is_paused !== undefined) {
        updates.push(`is_paused = $${idx++}`);
        params.push(Boolean(is_paused));
      }
      if (frequency !== undefined) {
        const validFrequencies = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
        if (!validFrequencies.includes(frequency)) {
          return res.status(400).json({ success: false, message: 'Invalid frequency' });
        }
        updates.push(`frequency = $${idx++}`);
        params.push(frequency);
      }
      if (amount !== undefined && parseFloat(amount) > 0) {
        updates.push(`amount = $${idx++}`);
        params.push(parseFloat(amount));
      }
      if (description !== undefined) {
        updates.push(`description = $${idx++}`);
        params.push(description || null);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      params.push(id, userId);
      const result = await pool.query(
        `UPDATE recurring_expenses SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Recurring expense not found' });
      }

      res.json({ success: true, recurring_expense: result.rows[0] });
    } catch (err) {
      console.error('Error updating recurring expense:', err);
      res.status(500).json({ success: false, message: 'Failed to update recurring expense' });
    }
  });

  // DELETE /api/recurring/expenses/:id — delete the entire series
  router.delete('/expenses/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const check = await pool.query(
        'SELECT id FROM recurring_expenses WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Recurring expense not found' });
      }

      // Unlink expense instances
      await pool.query(
        'UPDATE expenses SET recurring_expense_id = NULL WHERE recurring_expense_id = $1',
        [id]
      );

      // Delete template
      await pool.query('DELETE FROM recurring_expenses WHERE id = $1', [id]);

      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting recurring expense:', err);
      res.status(500).json({ success: false, message: 'Failed to delete recurring expense' });
    }
  });

  // ============================================================
  // GENERATION: create due instances
  // ============================================================

  // POST /api/recurring/generate — called on dashboard load to mint due instances
  router.post('/generate', async (req, res) => {
    try {
      const userId = req.user.id;
      const today = await fetchUserLocalDate(pool, userId);
      const generated = { tasks: [], expenses: [] };

      // Check Pro status for task limit
      const userIsPro = await isPro(userId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // -------- RECURRING TASKS --------
        const dueTasks = await client.query(`
          SELECT * FROM recurring_tasks
          WHERE user_id = $1 AND is_paused = false AND next_due_date <= $2
            AND (end_date IS NULL OR next_due_date <= end_date)
          ORDER BY next_due_date ASC
        `, [userId, today]);

        for (const rt of dueTasks.rows) {
          // Check if there's already an active (non-completed) instance for this recurring task
          const existing = await client.query(
            'SELECT id FROM tasks WHERE recurring_task_id = $1 AND is_completed = false AND user_id = $2 LIMIT 1',
            [rt.id, userId]
          );
          if (existing.rows.length > 0) {
            // Already has an active (uncompleted) instance — skip creation.
            // Don't advance the date; re-evaluate on next page load.
            continue;
          }

          // Check free-tier task limit
          if (!userIsPro) {
            const activeCount = await client.query(
              'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
              [userId]
            );
            if (parseInt(activeCount.rows[0].count) >= 10) {
              // Don't generate — limit reached; advance date so we try again next time
              const nextDate = calculateNextDate(rt.next_due_date, rt.frequency);
              await client.query(
                'UPDATE recurring_tasks SET next_due_date = $1 WHERE id = $2',
                [nextDate, rt.id]
              );
              continue;
            }
          }

          // Create new task instance
          const taskResult = await client.query(`
            INSERT INTO tasks (user_id, title, description, priority, due_date, source, recurring_task_id)
            VALUES ($1, $2, $3, $4, $5, 'recurring', $6) RETURNING *
          `, [userId, rt.title, rt.description, rt.priority, rt.next_due_date, rt.id]);

          generated.tasks.push(taskResult.rows[0]);

          // Advance next_due_date
          const nextDate = calculateNextDate(rt.next_due_date, rt.frequency);
          await client.query(
            'UPDATE recurring_tasks SET next_due_date = $1 WHERE id = $2',
            [nextDate, rt.id]
          );
        }

        // -------- RECURRING EXPENSES --------
        const dueExpenses = await client.query(`
          SELECT * FROM recurring_expenses
          WHERE user_id = $1 AND is_paused = false AND next_due_date <= $2
          ORDER BY next_due_date ASC
        `, [userId, today]);

        for (const re of dueExpenses.rows) {
          // Create expense instance
          const expResult = await client.query(`
            INSERT INTO expenses (user_id, amount, description, category_id, expense_date, source, recurring_expense_id)
            VALUES ($1, $2, $3, $4, $5, 'recurring', $6) RETURNING *
          `, [userId, re.amount, re.description, re.category_id, re.next_due_date, re.id]);

          generated.expenses.push(expResult.rows[0]);

          // Advance next_due_date
          const nextDate = calculateNextDate(re.next_due_date, re.frequency);
          await client.query(
            'UPDATE recurring_expenses SET next_due_date = $1 WHERE id = $2',
            [nextDate, re.id]
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      res.json({
        success: true,
        generated_tasks: generated.tasks.length,
        generated_expenses: generated.expenses.length
      });
    } catch (err) {
      console.error('Error generating recurring instances:', err);
      res.status(500).json({ success: false, message: 'Failed to generate recurring instances' });
    }
  });

  // ============================================================
  // ADVANCE: called when a recurring task instance is completed
  // POST /api/recurring/tasks/:id/advance
  // ============================================================
  router.post('/tasks/:id/advance', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const result = await pool.query(
        'SELECT * FROM recurring_tasks WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Recurring task not found' });
      }

      const rt = result.rows[0];
      // The next_due_date was already advanced when the instance was created.
      // Nothing extra to do — the generate endpoint will pick it up next time.
      res.json({ success: true, next_due_date: rt.next_due_date });
    } catch (err) {
      console.error('Error advancing recurring task:', err);
      res.status(500).json({ success: false, message: 'Failed to advance recurring task' });
    }
  });

  // ============================================================
  // CONVERT: one-time task → recurring
  // POST /api/recurring/tasks/from-task/:taskId
  // Body: { frequency }
  // Creates a recurring_tasks template using the existing task's data,
  // links the existing task instance, and does NOT create a duplicate.
  // ============================================================
  router.post('/tasks/from-task/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { frequency } = req.body;
      const userId = req.user.id;

      const validFrequencies = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
      if (!validFrequencies.includes(frequency)) {
        return res.status(400).json({ success: false, message: 'Invalid frequency' });
      }

      // Fetch the existing task (must belong to user, must not already be recurring)
      const taskResult = await pool.query(
        'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
        [taskId, userId]
      );
      if (taskResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }
      const task = taskResult.rows[0];
      if (task.recurring_task_id) {
        return res.status(409).json({ success: false, message: 'Task is already recurring' });
      }

      const userIsPro = await isPro(userId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check free-tier recurring task limit (max 2 active)
        if (!userIsPro) {
          const countRes = await client.query(
            'SELECT COUNT(*) as count FROM recurring_tasks WHERE user_id = $1 AND is_paused = false',
            [userId]
          );
          if (parseInt(countRes.rows[0].count) >= 2) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              success: false,
              recurring_limit_reached: true,
              message: "Free plan includes up to 2 active recurring tasks. Upgrade to Pro for unlimited recurring tasks."
            });
          }
        }

        // Use today (or the task's due_date if set) as the start date
        // WHY toISOString: task.due_date from PG is a JS Date; String(date).split('T')
        // splits on the 'T' in 'GMT' producing an invalid date like "Fri Aug 07 2026 00:00:00 GM"
        const today = await fetchUserLocalDate(pool, userId);
        const rawDue = task.due_date;
        const startDate = rawDue
          ? (rawDue instanceof Date ? rawDue.toISOString().split('T')[0] : String(rawDue).split('T')[0])
          : today;
        const nextDate = calculateNextDate(startDate, frequency);

        // Create recurring template
        const rtResult = await client.query(`
          INSERT INTO recurring_tasks (user_id, title, description, priority, frequency, start_date, next_due_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [userId, task.title, task.description, task.priority || 'medium',
            frequency, startDate, nextDate]);
        const recurringTask = rtResult.rows[0];

        // Link the existing task instance to this recurring template
        // and mark its source as 'recurring' so it shows the 🔁 badge
        await client.query(
          `UPDATE tasks SET recurring_task_id = $1, source = 'recurring' WHERE id = $2`,
          [recurringTask.id, taskId]
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          recurring_task: recurringTask,
          task_id: taskId
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error converting task to recurring:', err);
      res.status(500).json({ success: false, message: 'Failed to make task recurring' });
    }
  });

  // ============================================================
  // CONVERT: one-time expense → recurring
  // POST /api/recurring/expenses/from-expense/:expenseId
  // Body: { frequency }
  // Creates a recurring_expenses template using the existing expense's data,
  // links the existing expense instance, and does NOT create a duplicate.
  // ============================================================
  router.post('/expenses/from-expense/:expenseId', async (req, res) => {
    try {
      const { expenseId } = req.params;
      const { frequency } = req.body;
      const userId = req.user.id;

      const validFrequencies = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];
      if (!validFrequencies.includes(frequency)) {
        return res.status(400).json({ success: false, message: 'Invalid frequency' });
      }

      // Fetch the existing expense (must belong to user, must not already be recurring)
      const expResult = await pool.query(
        'SELECT * FROM expenses WHERE id = $1 AND user_id = $2',
        [expenseId, userId]
      );
      if (expResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Expense not found' });
      }
      const expense = expResult.rows[0];
      if (expense.recurring_expense_id) {
        return res.status(409).json({ success: false, message: 'Expense is already recurring' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // WHY toISOString: expense_date from PG is a JS Date — same bug as tasks (see above)
        const today = await fetchUserLocalDate(pool, userId);
        const rawDate = expense.expense_date;
        const startDate = rawDate
          ? (rawDate instanceof Date ? rawDate.toISOString().split('T')[0] : String(rawDate).split('T')[0])
          : today;
        const nextDate = calculateNextDate(startDate, frequency);

        // Create recurring template
        const reResult = await client.query(`
          INSERT INTO recurring_expenses (user_id, description, amount, category_id, frequency, start_date, next_due_date)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
        `, [userId, expense.description, parseFloat(expense.amount), expense.category_id,
            frequency, startDate, nextDate]);
        const recurringExpense = reResult.rows[0];

        // Link the existing expense instance to the recurring template
        await client.query(
          `UPDATE expenses SET recurring_expense_id = $1, source = 'recurring' WHERE id = $2`,
          [recurringExpense.id, expenseId]
        );

        await client.query('COMMIT');

        // Fetch with category info
        const reWithCat = await pool.query(`
          SELECT re.*, c.name as category_name, c.color as category_color, c.icon as category_icon
          FROM recurring_expenses re
          LEFT JOIN categories c ON c.id = re.category_id
          WHERE re.id = $1
        `, [recurringExpense.id]);

        res.json({
          success: true,
          recurring_expense: reWithCat.rows[0],
          expense_id: expenseId
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error converting expense to recurring:', err);
      res.status(500).json({ success: false, message: 'Failed to make expense recurring' });
    }
  });

  return router;
};
