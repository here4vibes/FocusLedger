const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
// WHY removed: sendNudgePushNotifications was called as a side effect of GET /nudges,
// causing duplicate push notifications on every page load. Task deadline notifications
// are now handled by a scheduled job (taskDeadlineNudge.js) with proper dedup.
const OpenAI = require('openai');
const { matchTaskToValue } = require('../lib/auto-tagger');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { actionableDateFilter } = require('../lib/task-filters');

module.exports = function(pool) {
  const router = express.Router();

  // All task routes require authentication
  router.use(authenticateToken);

  // GET all tasks with steps count (scoped to current user)
  router.get('/', async (req, res) => {
    try {
      const { filter, sort } = req.query; // filter: all/active/completed, sort: default/due_date
      const userId = req.user.id;
      let where = 'WHERE t.user_id = $1';
      const params = [userId];

      if (filter === 'active') where += ' AND t.is_completed = false';
      else if (filter === 'completed') where += ' AND t.is_completed = true';

      // Sort order: due_date puts tasks with due dates first (soonest), nulls last; default is created_at DESC
      const orderBy = sort === 'due_date'
        ? 'ORDER BY t.is_completed ASC, t.due_date ASC NULLS LAST, t.due_time ASC NULLS LAST, t.created_at DESC'
        : 'ORDER BY t.is_completed ASC, t.created_at DESC';

      const result = await pool.query(`
        SELECT t.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', s.id,
                'title', s.title,
                'is_completed', s.is_completed,
                'sort_order', s.sort_order,
                'completed_at', s.completed_at
              ) ORDER BY s.sort_order
            ) FILTER (WHERE s.id IS NOT NULL),
            '[]'
          ) as steps,
          COUNT(s.id) FILTER (WHERE s.id IS NOT NULL) as total_steps,
          COUNT(s.id) FILTER (WHERE s.is_completed = true) as completed_steps
        FROM tasks t
        LEFT JOIN task_steps s ON s.task_id = t.id
        ${where}
        GROUP BY t.id
        ${orderBy}
      `, params);

      res.json({ success: true, tasks: result.rows });
    } catch (err) {
      console.error('Error fetching tasks:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
    }
  });

  // GET dashboard summary (scoped to current user)
  // WHY $2 instead of CURRENT_DATE: CURRENT_DATE is UTC on Neon, which is wrong for
  // users in other timezones. We compute "today" server-side using the user's stored timezone.
  router.get('/summary', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localToday = getUserLocalDate(tz);

      // today_total = tasks relevant to today: due today (any status), overdue+incomplete,
      // no-due-date created today (incomplete), or completed today (any due date).
      // This avoids showing the entire backlog as "today's" count — critical for ADHD users.
      const result = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE NOT is_completed) as active_tasks,
          COUNT(*) FILTER (WHERE is_completed) as completed_tasks,
          COUNT(*) FILTER (WHERE is_completed AND (completed_at AT TIME ZONE $2)::date = $3::date) as completed_today,
          COUNT(*) FILTER (WHERE is_completed AND completed_at >= NOW() - INTERVAL '7 days') as completed_this_week,
          COUNT(*) FILTER (WHERE due_date = $3 AND NOT is_completed) as due_today,
          COUNT(*) FILTER (WHERE due_date < $3 AND NOT is_completed) as overdue,
          COUNT(*) FILTER (WHERE
            due_date::date = $3::date
            OR (due_date::date < $3::date AND NOT is_completed)
            OR (due_date IS NULL AND (created_at AT TIME ZONE $2)::date = $3::date AND NOT is_completed)
            OR (is_completed AND (completed_at AT TIME ZONE $2)::date = $3::date)
          ) as today_total
        FROM tasks
        WHERE user_id = $1
      `, [userId, tz, localToday]);
      res.json({ success: true, summary: result.rows[0] });
    } catch (err) {
      console.error('Error fetching summary:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch summary' });
    }
  });

  // GET nudges — tasks approaching their due date or overdue (scoped to current user)
  // WHY user timezone: due_date is a local calendar date. For a task due "today" with no due_time,
  // the deadline is end-of-local-day. Using UTC end-of-day would misclassify tasks for users in
  // +UTC timezones (Tokyo: tasks due today would appear overdue by UTC before local EOD).
  // We compute due_at using Date.UTC() from the local date+time components — correctly converts
  // wall-clock time in the user's timezone to UTC regardless of the timezone offset.
  router.get('/nudges', async (req, res) => {
    try {
      const userId = req.user.id;
      const now = new Date();

      const result = await pool.query(`
        SELECT id, title, due_date, due_time
        FROM tasks
        WHERE user_id = $1
          AND is_completed = false
          AND due_date IS NOT NULL
        ORDER BY due_date ASC, due_time ASC NULLS LAST
      `, [userId]);

      const nudges = [];
      result.rows.forEach(task => {
        let dueAtUTC;
        if (task.due_time) {
          // Specific time: due_date + due_time in user's local tz → UTC.
          // E.g., task due today 14:00 in Tokyo → UTC timestamp of 14:00 Tokyo today.
          const [th, tm] = task.due_time.split(':').map(Number);
          const [dy, dm, dd] = task.due_date.split('-').map(Number);
          dueAtUTC = new Date(Date.UTC(dy, dm - 1, dd, th, tm, 0, 0));
        } else {
          // No due_time: task is due by end of the due_date in user's local tz.
          // EOD = start of next calendar day in user's tz, minus 1 second.
          const [ty, tm2, td2] = task.due_date.split('-').map(Number);
          const taskTomorrow = new Date(Date.UTC(ty, tm2 - 1, td2 + 1));
          dueAtUTC = new Date(taskTomorrow.getTime() - 1000);
        }

        const msUntilDue = dueAtUTC - now;
        const hoursUntilDue = msUntilDue / (1000 * 60 * 60);

        if (msUntilDue < 0) {
          nudges.push({ id: task.id, title: task.title, due_date: task.due_date, due_time: task.due_time, due_at: dueAtUTC.toISOString(), type: 'overdue' });
        } else if (hoursUntilDue <= 1) {
          nudges.push({ id: task.id, title: task.title, due_date: task.due_date, due_time: task.due_time, due_at: dueAtUTC.toISOString(), type: '1h' });
        } else if (hoursUntilDue <= 24) {
          nudges.push({ id: task.id, title: task.title, due_date: task.due_date, due_time: task.due_time, due_at: dueAtUTC.toISOString(), type: '24h' });
        }
      });

      res.json({ success: true, nudges });

      // WHY no push here: push notifications for task deadlines are now handled by
      // the taskDeadlineNudge.js scheduler (runs every 15 min with dedup).
    } catch (err) {
      console.error('Error fetching nudges:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch nudges' });
    }
  });
  router.post('/suggest-steps', async (req, res) => {
    try {
      const { title } = req.body;
      const userId = req.user.id;

      if (!title || !title.trim()) {
        return res.json({ success: true, suggestions: [], skip: true });
      }

      const trimmedTitle = title.trim();

      // Simple task heuristic: single-action verbs with short titles → skip
      const simpleVerbPattern = /^(buy|get|call|send|pay|text|pick up|drop off|schedule|book|email|message|order|print|sign|read|watch|listen|check|return|deliver|grab|fetch|remind|tell|ask|give|take|bring|clean up|tidy|wash)\b/i;
      const wordCount = trimmedTitle.split(/\s+/).length;
      if (simpleVerbPattern.test(trimmedTitle) && wordCount <= 5) {
        return res.json({ success: true, suggestions: [], skip: true, reason: 'simple_task' });
      }

      // Pro gate
      let isPro = false;
      try {
        isPro = await checkProStatus(pool, userId);
      } catch (e) {
        // Fail open: if Pro check fails, don't block AI suggestions (non-critical feature)
        console.error('[suggest-steps] Subscription check failed:', e.message);
        isPro = false;
      }

      if (!isPro) {
        return res.json({ success: true, suggestions: [], skip: false, is_pro: false });
      }

      // Call OpenAI with 3s timeout
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      );

      const completionPromise = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a task decomposition assistant helping people with ADHD break down tasks into concrete steps. Generate 3-5 short, specific, actionable steps. Each step must: start with an action verb, be under 10 words, be concrete not vague. Return ONLY a valid JSON array of strings, nothing else. Example: ["Open bank website and log in", "Navigate to transfers section", "Enter amount and recipient", "Confirm and save confirmation number"]'
          },
          {
            role: 'user',
            content: 'Task: "' + trimmedTitle + '"\n\nGenerate 3-5 actionable steps as a JSON array.'
          }
        ],
        max_tokens: 250,
        temperature: 0.6,
      });

      let completion;
      try {
        completion = await Promise.race([completionPromise, timeoutPromise]);
      } catch (raceErr) {
        if (raceErr.message === 'timeout') {
          return res.json({ success: true, suggestions: [], skip: true, reason: 'timeout' });
        }
        throw raceErr;
      }

      const content = (completion.choices[0].message.content || '').trim();
      let suggestions = [];

      try {
        // Strip markdown code fences if present
        const cleaned = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          suggestions = parsed.slice(0, 5).map(s => String(s).trim()).filter(s => s.length > 2);
        }
      } catch {
        // Fallback: extract lines that look like steps
        suggestions = content
          .split('\n')
          .map(line => line.replace(/^[\d\-\.\*\[\]"'\s]+|[\s"'\]]+$/g, '').trim())
          .filter(line => line.length > 3)
          .slice(0, 5);
      }

      if (suggestions.length === 0) {
        return res.json({ success: true, suggestions: [], skip: true, reason: 'no_steps' });
      }

      res.json({ success: true, suggestions, is_pro: true });
    } catch (err) {
      console.error('[suggest-steps] Error:', err.message);
      // Always silent-fail — never block the user
      res.json({ success: true, suggestions: [], skip: true, reason: 'error' });
    }
  });

  // ── TASK DURATION ────────────────────────────────────────────────────────────
  // POST /api/tasks/suggest-duration
  // AI estimates how long a task will take based on title.
  // Returns duration_minutes (integer). Silent-fail on any error.
  router.post('/suggest-duration', async (req, res) => {
    try {
      const { title } = req.body;
      if (!title || !title.trim() || title.trim().length < 3) {
        return res.json({ success: true, duration_minutes: null });
      }

      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 4000)
      );

      const completionPromise = openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a task time estimator. Given a task title, estimate how long it will take in minutes. Be realistic. Common ranges: quick tasks 5-15 min, medium tasks 30-60 min, complex tasks 90-180 min. Return ONLY a JSON object: {"minutes": <integer>}. No explanation.'
          },
          {
            role: 'user',
            content: `Task: "${title.trim()}"\nHow many minutes will this take?`
          }
        ],
        max_tokens: 50,
        temperature: 0.3,
      });

      let completion;
      try {
        completion = await Promise.race([completionPromise, timeoutPromise]);
      } catch {
        return res.json({ success: true, duration_minutes: null });
      }

      const content = (completion.choices[0].message.content || '').trim();
      let minutes = null;
      try {
        const cleaned = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
          // Cap at 8 hours to avoid absurd estimates
          minutes = Math.min(Math.round(parsed.minutes), 480);
        }
      } catch {
        // Try extracting a number directly
        const match = content.match(/\d+/);
        if (match) minutes = Math.min(parseInt(match[0]), 480);
      }

      res.json({ success: true, duration_minutes: minutes });
    } catch (_err) {
      // Always silent-fail — never block the user
      res.json({ success: true, duration_minutes: null });
    }
  });

  // PATCH /api/tasks/:id/duration — set duration manually (user-initiated)
  router.patch('/:id/duration', async (req, res) => {
    try {
      const { id } = req.params;
      const { duration_minutes } = req.body;
      const userId = req.user.id;

      const mins = duration_minutes === null || duration_minutes === undefined
        ? null
        : parseInt(duration_minutes);

      if (mins !== null && (isNaN(mins) || mins < 1 || mins > 1440)) {
        return res.status(400).json({ success: false, message: 'Duration must be between 1 and 1440 minutes.' });
      }

      const result = await pool.query(
        `UPDATE tasks SET duration_minutes = $1, duration_source = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4 RETURNING *`,
        [mins, mins === null ? null : 'manual', id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      res.json({ success: true, task: result.rows[0] });
    } catch (_err) {
      res.status(500).json({ success: false, message: 'Failed to update duration' });
    }
  });

  // GET single task with steps (scoped to current user)
  // Used by task detail view and focus mode.
  router.get('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT t.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', s.id,
                'title', s.title,
                'is_completed', s.is_completed,
                'sort_order', s.sort_order,
                'completed_at', s.completed_at
              ) ORDER BY s.sort_order
            ) FILTER (WHERE s.id IS NOT NULL),
            '[]'
          ) as steps
        FROM tasks t
        LEFT JOIN task_steps s ON s.task_id = t.id
        WHERE t.id = $1 AND t.user_id = $2
        GROUP BY t.id
      `, [id, userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      res.json({ success: true, task: result.rows[0] });
    } catch (err) {
      console.error('Error fetching task:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch task' });
    }
  });

  // POST create task (scoped to current user)
  router.post('/', async (req, res) => {
    try {
      const { title, description, priority, due_date, steps,
              source, merchant_hint, expected_amount, duration_minutes,
              is_household, is_shared_with_partner } = req.body;
      const userId = req.user.id;

      if (!title || !title.trim()) {
        // De Botton: frame as a question, not a command
        return res.status(400).json({ success: false, message: 'What should this task be called?' });
      }
      if (title.trim().length > 150) {
        return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });
      }

      // Check task limit for free users (per-user)
      try {
        const isPro = await checkProStatus(pool, userId);

        if (!isPro) {
          const activeCount = await pool.query(
            'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
            [userId]
          );
          if (parseInt(activeCount.rows[0].count) >= 10) {
            // De Botton: no shame, no alarm. State the constraint with dignity.
            // McLuhan: the upgrade prompt IS the message — make it an invitation, not a gate.
            return res.status(402).json({
              success: false,
              message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Autopilot.',
              code: 'TASK_LIMIT_REACHED',
              upgrade_required: true
            });
          }
        }
      } catch (subErr) {
        // If subscription check fails, deny task creation (fail closed for security)
        console.error('Subscription check failed (denying task creation):', subErr.message);
        return res.status(500).json({
          success: false,
          message: 'Unable to verify subscription status. Please try again.',
          code: 'SUBSCRIPTION_CHECK_FAILED'
        });
      }

      // Auto-tag: find matching value for this task title
      let autoValueId = null;
      try {
        autoValueId = await matchTaskToValue(pool, userId, title.trim());
      } catch (e) {
        // Non-blocking — if auto-tag fails, task still creates fine
        console.warn('[Tasks] Auto-tag failed:', e.message);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Normalize duration: accept explicit value from body, or null
        const durationMins = duration_minutes ? parseInt(duration_minutes) : null;
        const durationSource = durationMins ? 'manual' : null;

        const taskResult = await client.query(
          `INSERT INTO tasks (title, description, priority, due_date, user_id,
                              source, merchant_hint, expected_amount, value_id,
                              duration_minutes, duration_source,
                              is_household, is_shared_with_partner)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
          [title.trim(), description || null, priority || 'medium', due_date || null, userId,
           source || 'manual', merchant_hint || null,
           expected_amount ? parseFloat(expected_amount) : null,
           autoValueId,
           durationMins, durationSource,
           Boolean(is_household), Boolean(is_shared_with_partner)]
        );
        const task = taskResult.rows[0];

        // Insert steps if provided
        if (steps && steps.length > 0) {
          for (let i = 0; i < steps.length; i++) {
            await client.query(
              `INSERT INTO task_steps (task_id, title, sort_order)
               VALUES ($1, $2, $3)`,
              [task.id, steps[i].trim(), i]
            );
          }
        }

        await client.query('COMMIT');

        // Fetch complete task with steps (fallback to basic task if fetch fails)
        let responseTask = task;
        try {
          const fullTask = await pool.query(`
            SELECT t.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', s.id, 'title', s.title,
                    'is_completed', s.is_completed,
                    'sort_order', s.sort_order
                  ) ORDER BY s.sort_order
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) as steps
            FROM tasks t
            LEFT JOIN task_steps s ON s.task_id = t.id
            WHERE t.id = $1 AND t.user_id = $2
            GROUP BY t.id
          `, [task.id, userId]);
          if (fullTask && fullTask.rows && fullTask.rows[0]) {
            responseTask = fullTask.rows[0];
          }
        } catch {
          // Use basic task data from INSERT
          responseTask.steps = [];
        }

        res.status(201).json({ success: true, task: responseTask });

        // Fire-and-forget: AI auto-generate duration if user didn't set one.
        // Updates the DB in the background — client polls on next load.
        if (!durationMins) {
          setImmediate(async () => {
            try {
              const openai = new OpenAI({
                baseURL: process.env.OPENAI_BASE_URL,
                apiKey: process.env.OPENAI_API_KEY,
              });
              const completion = await Promise.race([
                openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  messages: [
                    { role: 'system', content: 'Estimate task duration in minutes. Return ONLY JSON: {"minutes": <integer>}. Ranges: quick 5-15, medium 30-60, complex 90-180. No explanation.' },
                    { role: 'user', content: `Task: "${task.title}"` }
                  ],
                  max_tokens: 50,
                  temperature: 0.3,
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
              ]);
              const raw = (completion.choices[0].message.content || '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
                const mins = Math.min(Math.round(parsed.minutes), 480);
                await pool.query(
                  `UPDATE tasks SET duration_minutes = $1, duration_source = 'ai', updated_at = NOW() WHERE id = $2`,
                  [mins, task.id]
                );
              }
            } catch {
              // Silent fail — AI duration is a nice-to-have, never a blocker
            }
          });
        }
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Error creating task:', err);
      res.status(500).json({ success: false, message: 'Failed to create task' });
    }
  });

  // PATCH update task fields — due_date, due_time, title, value_id (scoped to current user)
  router.patch('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { due_date, due_time, title, value_id, notes,
              is_household, is_shared_with_partner, is_completed } = req.body;
      const userId = req.user.id;

      const updates = [];
      const params = [];
      let paramIdx = 1;

      if (due_date !== undefined) {
        updates.push(`due_date = $${paramIdx++}`);
        params.push(due_date || null);
      }
      if (due_time !== undefined) {
        updates.push(`due_time = $${paramIdx++}`);
        params.push(due_time || null);
      }
      if (title !== undefined && title.trim()) {
        if (title.trim().length > 150) {
          return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });
        }
        updates.push(`title = $${paramIdx++}`);
        params.push(title.trim());
      }
      if (value_id !== undefined) {
        updates.push(`value_id = $${paramIdx++}`);
        params.push(value_id === null || value_id === 0 ? null : parseInt(value_id));
      }
      if (notes !== undefined) {
        updates.push(`notes = $${paramIdx++}`);
        params.push(notes === '' ? null : notes);
      }
      if (is_household !== undefined) {
        updates.push(`is_household = $${paramIdx++}`);
        params.push(Boolean(is_household));
      }
      if (is_shared_with_partner !== undefined) {
        updates.push(`is_shared_with_partner = $${paramIdx++}`);
        params.push(Boolean(is_shared_with_partner));
      }
      if (is_completed !== undefined) {
        updates.push(`is_completed = $${paramIdx++}`);
        params.push(Boolean(is_completed));
        if (is_completed) {
          updates.push(`completed_at = NOW()`);
        } else {
          updates.push(`completed_at = NULL`);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      params.push(id, userId);

      const result = await pool.query(
        `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${paramIdx++} AND user_id = $${paramIdx} RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      res.json({ success: true, task: result.rows[0] });
    } catch (err) {
      console.error('Error updating task:', err);
      res.status(500).json({ success: false, message: 'Failed to update task' });
    }
  });

  // ============================================================
  // HELPER: Calculate next occurrence date for recurring tasks
  // (duplicated from routes/recurring.js to avoid circular deps)
  // ============================================================
  function calculateNextDate(fromDate, frequency) {
    // Normalize to YYYY-MM-DD string — handles both string and Date inputs
    // (pg returns DATE columns as JS Date objects, not ISO strings)
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
      default:
        base.setDate(base.getDate() + 7);
    }

    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, '0');
    const dd = String(base.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  // ============================================================
  // HELPER: Spawn the next recurring task instance after completion
  // ============================================================
  async function spawnNextRecurringInstance(pool, completedTask, userId) {
    if (!completedTask.recurring_task_id) return null;

    try {
      // Look up the recurring template
      const rtResult = await pool.query(
        'SELECT * FROM recurring_tasks WHERE id = $1 AND user_id = $2',
        [completedTask.recurring_task_id, userId]
      );
      if (rtResult.rows.length === 0) return null;

      const rt = rtResult.rows[0];

      // Don't spawn if paused or past end_date
      if (rt.is_paused) return null;
      if (rt.end_date && new Date(rt.next_due_date) > new Date(rt.end_date)) return null;

      // Guard: don't create if there's already an active (uncompleted) instance
      const existing = await pool.query(
        'SELECT id FROM tasks WHERE recurring_task_id = $1 AND is_completed = false AND user_id = $2 LIMIT 1',
        [rt.id, userId]
      );
      if (existing.rows.length > 0) return null;

      // Compute the next due date FIRST, then use it for both the new task and the template.
      // Fix: previously used rt.next_due_date (current stale value) for the task's due_date,
      // then advanced. Now we advance first so the new task gets the correct next date.
      const advancedDate = calculateNextDate(rt.next_due_date, rt.frequency);

      // Create the next task instance
      const nextTask = await pool.query(`
        INSERT INTO tasks (user_id, title, description, priority, due_date, source, recurring_task_id, value_id)
        VALUES ($1, $2, $3, $4, $5, 'recurring', $6, $7) RETURNING *
      `, [userId, rt.title, rt.description, rt.priority, advancedDate, rt.id, completedTask.value_id || null]);

      // Advance the recurring template's next_due_date
      await pool.query(
        'UPDATE recurring_tasks SET next_due_date = $1 WHERE id = $2',
        [advancedDate, rt.id]
      );

      return nextTask.rows[0];
    } catch (err) {
      console.error('Error spawning next recurring instance:', err);
      return null;
    }
  }

  // PATCH toggle task completion (scoped to current user)
  router.patch('/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const result = await pool.query(
        `UPDATE tasks SET
          is_completed = NOT is_completed,
          completed_at = CASE WHEN is_completed THEN NULL ELSE NOW() END,
          updated_at = NOW()
         WHERE id = $1 AND user_id = $2 RETURNING *`,
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      const task = result.rows[0];
      let nextRecurringTask = null;

      // If completing task, also complete all steps
      if (task.is_completed) {
        await pool.query(
          `UPDATE task_steps SET is_completed = true, completed_at = NOW() WHERE task_id = $1`,
          [id]
        );

        // If this is a recurring task, spawn the next instance immediately
        nextRecurringTask = await spawnNextRecurringInstance(pool, task, userId);
      }

      res.json({ success: true, task, next_recurring_task: nextRecurringTask });
    } catch (err) {
      console.error('Error toggling task:', err);
      res.status(500).json({ success: false, message: 'Failed to toggle task' });
    }
  });

  // PATCH toggle step completion (verify task ownership)
  router.patch('/:taskId/steps/:stepId/toggle', async (req, res) => {
    try {
      const { taskId, stepId } = req.params;
      const userId = req.user.id;

      // Verify task belongs to user
      const taskCheck = await pool.query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [taskId, userId]
      );
      if (taskCheck.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      const result = await pool.query(
        `UPDATE task_steps SET
          is_completed = NOT is_completed,
          completed_at = CASE WHEN NOT is_completed THEN NULL ELSE NOW() END
         WHERE id = $1 AND task_id = $2 RETURNING *`,
        [stepId, taskId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Step not found' });
      }

      // Check if all steps complete -> auto-complete task
      const stepsCheck = await pool.query(
        `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_completed) as done
         FROM task_steps WHERE task_id = $1`,
        [taskId]
      );
      const { total, done } = stepsCheck.rows[0];
      let nextRecurringTask = null;
      if (parseInt(total) > 0 && parseInt(total) === parseInt(done)) {
        const autoCompleted = await pool.query(
          `UPDATE tasks SET is_completed = true, completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
          [taskId]
        );
        // Spawn next recurring instance when task auto-completes via steps
        if (autoCompleted.rows.length > 0) {
          nextRecurringTask = await spawnNextRecurringInstance(pool, autoCompleted.rows[0], userId);
        }
      } else if (parseInt(done) < parseInt(total)) {
        // Unchecking a step should uncomplete the parent task
        await pool.query(
          `UPDATE tasks SET is_completed = false, completed_at = NULL, updated_at = NOW() WHERE id = $1 AND is_completed = true`,
          [taskId]
        );
      }

      res.json({ success: true, step: result.rows[0], next_recurring_task: nextRecurringTask });
    } catch (err) {
      console.error('Error toggling step:', err);
      res.status(500).json({ success: false, message: 'Failed to toggle step' });
    }
  });

  // PATCH update step title or sort_order (verify task ownership)
  router.patch('/:taskId/steps/:stepId', async (req, res) => {
    try {
      const { taskId, stepId } = req.params;
      const { title, sort_order } = req.body;
      const userId = req.user.id;

      // Verify task belongs to user
      const taskCheck = await pool.query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [taskId, userId]
      );
      if (taskCheck.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      const updates = [];
      const values = [];
      if (title !== undefined) {
        if (!title.trim()) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
        updates.push(`title = $${values.length + 1}`);
        values.push(title.trim());
      }
      if (sort_order !== undefined) {
        updates.push(`sort_order = $${values.length + 1}`);
        values.push(sort_order);
      }
      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'Nothing to update' });
      }

      values.push(stepId);
      values.push(taskId);
      const result = await pool.query(
        `UPDATE task_steps SET ${updates.join(', ')} WHERE id = $${values.length - 1} AND task_id = $${values.length} RETURNING *`,
        values
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Step not found' });
      }

      res.json({ success: true, step: result.rows[0] });
    } catch (err) {
      console.error('Error updating step:', err);
      res.status(500).json({ success: false, message: 'Failed to update step' });
    }
  });

  // POST add step to existing task (verify task ownership)
  router.post('/:taskId/steps', async (req, res) => {
    try {
      const { taskId } = req.params;
      const { title } = req.body;
      const userId = req.user.id;

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Title is required' });
      }

      // Verify task belongs to user
      const taskCheck = await pool.query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [taskId, userId]
      );
      if (taskCheck.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      // Get max sort_order
      const maxOrder = await pool.query(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM task_steps WHERE task_id = $1',
        [taskId]
      );

      const result = await pool.query(
        `INSERT INTO task_steps (task_id, title, sort_order)
         VALUES ($1, $2, $3) RETURNING *`,
        [taskId, title.trim(), maxOrder.rows[0].next_order]
      );

      res.status(201).json({ success: true, step: result.rows[0] });
    } catch (err) {
      console.error('Error adding step:', err);
      res.status(500).json({ success: false, message: 'Failed to add step' });
    }
  });

  // DELETE task (scoped to current user)
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const result = await pool.query(
        'DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting task:', err);
      res.status(500).json({ success: false, message: 'Failed to delete task' });
    }
  });

  // DELETE step (verify task ownership)
  router.delete('/:taskId/steps/:stepId', async (req, res) => {
    try {
      const { taskId, stepId } = req.params;
      const userId = req.user.id;

      // Verify task belongs to user
      const taskCheck = await pool.query(
        'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
        [taskId, userId]
      );
      if (taskCheck.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Task not found' });
      }

      await pool.query('DELETE FROM task_steps WHERE id = $1 AND task_id = $2', [stepId, taskId]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting step:', err);
      res.status(500).json({ success: false, message: 'Failed to delete step' });
    }
  });

  // ── MORNING LAUNCH: Effort-sorted tasks ──────────────────────────────────────
  // GET /api/tasks/morning-launch
  // Returns incomplete tasks sorted by effort score (easiest first):
  //   Primary: step count ASC (fewer = easier)
  //   Secondary: overdue tasks get a boost (surface before future-due)
  //   Tertiary: task age ASC (older first — counter avoidance buildup)
  // Also returns per-task skip count (for avoidance detection) and streak info.
  router.get('/morning-launch', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localToday = getUserLocalDate(tz);

      // Tasks with effort scoring
      const tasksResult = await pool.query(`
        SELECT
          t.id,
          t.title,
          t.due_date,
          t.created_at,
          COUNT(s.id)::int                                          AS step_count,
          CASE WHEN t.due_date < $2::date THEN 1 ELSE 0 END        AS is_overdue,
          COALESCE(me.skip_count, 0)::int                           AS skip_count
        FROM tasks t
        LEFT JOIN task_steps s ON s.task_id = t.id
        LEFT JOIN (
          SELECT task_id, COUNT(*)::int AS skip_count
          FROM morning_task_events
          WHERE user_id = $1 AND event_type = 'skipped'
          GROUP BY task_id
        ) me ON me.task_id = t.id
        WHERE t.user_id = $1 AND t.is_completed = false
          AND ${actionableDateFilter(2, 't')}
        GROUP BY t.id, me.skip_count
        ORDER BY
          COUNT(s.id) ASC,
          CASE WHEN t.due_date < $2::date THEN 0 ELSE 1 END ASC,
          t.created_at ASC
      `, [userId, localToday]);

      // Today's streak
      const streakResult = await pool.query(`
        SELECT current_streak, longest_streak, last_completed_date
        FROM morning_streaks
        WHERE user_id = $1
      `, [userId]);
      const streak = streakResult.rows[0] || { current_streak: 0, longest_streak: 0, last_completed_date: null };

      // Check if already launched today
      const todaySession = await pool.query(`
        SELECT id, tasks_completed, tasks_skipped
        FROM morning_sessions
        WHERE user_id = $1 AND session_date = $2
        ORDER BY completed_at DESC LIMIT 1
      `, [userId, localToday]);

      res.json({
        success: true,
        tasks: tasksResult.rows,
        streak: {
          current: streak.current_streak,
          longest: streak.longest_streak,
          last_date: streak.last_completed_date
        },
        already_launched_today: todaySession.rows.length > 0,
        today_session: todaySession.rows[0] || null
      });
    } catch (err) {
      console.error('[Morning Launch] Error fetching tasks:', err);
      res.status(500).json({ success: false, message: 'Failed to load morning launch' });
    }
  });

  // ── MORNING LAUNCH: Streak info ───────────────────────────────────────────────
  // GET /api/tasks/streak
  router.get('/streak', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(`
        SELECT current_streak, longest_streak, last_completed_date
        FROM morning_streaks
        WHERE user_id = $1
      `, [userId]);
      const row = result.rows[0] || { current_streak: 0, longest_streak: 0, last_completed_date: null };
      res.json({
        success: true,
        current_streak: row.current_streak,
        longest_streak: row.longest_streak,
        last_completed_date: row.last_completed_date
      });
    } catch (err) {
      console.error('[Morning Launch] Error fetching streak:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch streak' });
    }
  });

  // ── MORNING LAUNCH: Record session + task events ──────────────────────────────
  // POST /api/tasks/morning-launch/session
  // Body: { tasks_completed: int, tasks_skipped: int, events: [{ task_id, event_type }] }
  router.post('/morning-launch/session', async (req, res) => {
    try {
      const userId = req.user.id;
      const { tasks_completed = 0, tasks_skipped = 0, events = [] } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const localToday = getUserLocalDate(tz);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Record session
        await client.query(`
          INSERT INTO morning_sessions (user_id, session_date, tasks_completed, tasks_skipped)
          VALUES ($1, $2, $3, $4)
        `, [userId, localToday, tasks_completed, tasks_skipped]);

        // Record task-level events (completions + skips for avoidance detection)
        for (const ev of events) {
          if (!ev.task_id || !['completed', 'skipped'].includes(ev.event_type)) continue;
          await client.query(`
            INSERT INTO morning_task_events (user_id, task_id, event_type, session_date)
            VALUES ($1, $2, $3, $4)
          `, [userId, ev.task_id, ev.event_type, localToday]);
        }

        // Update streak
        // Logic:
        //   - If last_completed_date = today: already counted (idempotent)
        //   - If last_completed_date = yesterday: increment
        //   - If last_completed_date = 2 days ago AND grace_day_available: use grace day, increment
        //   - Otherwise: reset to 1
        const streakRow = await client.query(`
          SELECT current_streak, longest_streak, last_completed_date, grace_day_available
          FROM morning_streaks WHERE user_id = $1 FOR UPDATE
        `, [userId]);

        let newStreak, newLongest, newGrace;
        // WHY: use the user's local date for streak calculations, not server time
        const todayMidnight = new Date(localToday + 'T00:00:00');
        const today = todayMidnight;

        if (streakRow.rows.length === 0) {
          // First ever session
          newStreak = 1;
          newLongest = 1;
          newGrace = true;
        } else {
          const existing = streakRow.rows[0];
          const lastDate = existing.last_completed_date ? new Date(existing.last_completed_date) : null;
          if (lastDate) lastDate.setHours(0, 0, 0, 0);
          const daysDiff = lastDate ? Math.round((today - lastDate) / 86400000) : 999;

          if (daysDiff === 0) {
            // Already counted today — no change
            newStreak = existing.current_streak;
            newLongest = existing.longest_streak;
            newGrace = existing.grace_day_available;
          } else if (daysDiff === 1) {
            // Consecutive day
            newStreak = existing.current_streak + 1;
            newLongest = Math.max(existing.longest_streak, newStreak);
            newGrace = true; // reset grace availability after a successful day
          } else if (daysDiff === 2 && existing.grace_day_available) {
            // Grace day — missed yesterday but had grace available
            newStreak = existing.current_streak + 1;
            newLongest = Math.max(existing.longest_streak, newStreak);
            newGrace = false; // grace used
          } else {
            // Streak broken
            newStreak = 1;
            newLongest = Math.max(existing.longest_streak, 1);
            newGrace = true;
          }
        }

        await client.query(`
          INSERT INTO morning_streaks (user_id, current_streak, longest_streak, last_completed_date, grace_day_available, updated_at)
          VALUES ($1, $2, $3, $5, $4, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            current_streak      = EXCLUDED.current_streak,
            longest_streak      = EXCLUDED.longest_streak,
            last_completed_date = EXCLUDED.last_completed_date,
            grace_day_available = EXCLUDED.grace_day_available,
            updated_at          = NOW()
        `, [userId, newStreak, newLongest, newGrace, localToday]);

        await client.query('COMMIT');

        res.json({
          success: true,
          streak: { current: newStreak, longest: newLongest }
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[Morning Launch] Error saving session:', err);
      res.status(500).json({ success: false, message: 'Failed to save session' });
    }
  });

  return router;
};
