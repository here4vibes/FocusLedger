// Phase 3A: Tasks CRUD backed by pg.Pool (Prisma removed).
// Owns: task CRUD, steps CRUD, summary, nudges, suggest-steps, suggest-duration.
// Does NOT own: auth middleware, pro status check, recurring task spawning.
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { complete } = require('../lib/claude-client');

// ── Helpers: time string normalization ───────────────────────────────────────
// DB stores time as 'time without time zone'; pg returns it as a string "HH:MM:SS".
// Frontend sends/expects "HH:MM" strings — slice to normalize.
function normTask(t) {
  if (!t) return t;
  return {
    ...t,
    due_time: t.due_time ? String(t.due_time).slice(0, 5) : null,
    recurrence_type: t.recurrence_type || 'none',
    steps: t.steps || [],
  };
}

// Spawn the next occurrence of a recurring task
function spawnNextOccurrence(task, userId) {
  if (!task.due_date) return null;
  if (!task.recurrence_type || task.recurrence_type === 'none') return null;

  const freq = task.recurrence_type;
  const base = new Date(task.due_date);

  let nextDate;
  if (freq === 'daily') {
    nextDate = new Date(base.getTime() + 86400000);
  } else if (freq === 'weekdays') {
    do { base.setDate(base.getDate() + 1); } while (base.getDay() === 0 || base.getDay() === 6);
    nextDate = base;
  } else if (freq === 'weekly') {
    const targetDay = task.recurrence_day != null ? task.recurrence_day : base.getDay();
    const currentDay = base.getDay();
    const daysToAdd = (targetDay - currentDay + 7) % 7 || 7;
    nextDate = new Date(base.getTime() + daysToAdd * 86400000);
  } else if (freq === 'monthly') {
    const targetDom = task.recurrence_day != null ? task.recurrence_day : base.getDate();
    nextDate = new Date(base.getFullYear(), base.getMonth() + 1, targetDom);
  } else {
    return null;
  }

  return {
    user_id: userId,
    title: task.title,
    description: task.description || null,
    priority: task.priority || 'medium',
    due_date: nextDate,
    due_time: task.due_time || null,
    source: 'recurring',
    value_id: task.value_id || null,
    notes: task.notes || null,
    recurrence_type: task.recurrence_type,
    recurrence_day: task.recurrence_day,
  };
}

// ── Auth middleware (use both session + JWT) ─────────────────────────────────
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

// ── GET /api/tasks ────────────────────────────────────────────────────────────
async function listTasks(req, res) {
  try {
    const { filter = 'all', sort = 'default' } = req.query;
    const userId = req.user.id;

    let whereClause = 'WHERE t.user_id = $1';
    if (filter === 'active') whereClause += ' AND t.is_completed = false';
    else if (filter === 'completed') whereClause += ' AND t.is_completed = true';

    const orderClause = sort === 'due_date'
      ? 'ORDER BY t.is_completed ASC, t.due_date ASC NULLS LAST, t.due_time ASC NULLS LAST, t.created_at DESC'
      : 'ORDER BY t.is_completed ASC, t.created_at DESC';

    const sql = `
      SELECT t.*,
        COALESCE(json_agg(json_build_object(
          'id', s.id, 'task_id', s.task_id, 'title', s.title,
          'is_completed', s.is_completed, 'sort_order', s.sort_order,
          'completed_at', s.completed_at, 'created_at', s.created_at
        ) ORDER BY s.sort_order) FILTER (WHERE s.id IS NOT NULL), '[]') AS steps,
        COUNT(s.id) FILTER (WHERE s.id IS NOT NULL)::int AS total_steps,
        COUNT(s.id) FILTER (WHERE s.is_completed)::int AS completed_steps
      FROM tasks t
      LEFT JOIN task_steps s ON s.task_id = t.id
      ${whereClause}
      GROUP BY t.id
      ${orderClause}
    `;

    const { rows } = await res.locals._pool.query(sql, [userId]);
    const enriched = rows.map(normTask);
    res.json({ success: true, tasks: enriched });
  } catch (err) {
    console.error('[tasks] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

// ── GET /api/tasks/summary ────────────────────────────────────────────────────
async function getSummary(req, res) {
  try {
    const userId = req.user.id;
    const pool = res.locals._pool;
    const tz = await fetchUserTimezone(pool, userId);
    const localToday = getUserLocalDate(tz);

    const sql = `
      SELECT
        COUNT(*)::int                                  AS total,
        COUNT(*) FILTER (WHERE NOT is_completed)::int  AS active_tasks,
        COUNT(*) FILTER (WHERE is_completed)::int      AS completed_tasks,
        COUNT(*) FILTER (WHERE is_completed AND (completed_at AT TIME ZONE $2)::date = $3::date)::int AS completed_today,
        COUNT(*) FILTER (WHERE is_completed AND completed_at >= NOW() - INTERVAL '7 days')::int AS completed_this_week,
        COUNT(*) FILTER (WHERE due_date = $3::date AND NOT is_completed)::int AS due_today,
        COUNT(*) FILTER (WHERE due_date < $3::date AND NOT is_completed)::int AS overdue,
        COUNT(*) FILTER (WHERE
          due_date::date = $3::date
          OR (due_date::date < $3::date AND NOT is_completed)
          OR (due_date IS NULL AND (created_at AT TIME ZONE $2)::date = $3::date AND NOT is_completed)
          OR (is_completed AND (completed_at AT TIME ZONE $2)::date = $3::date)
        )::int AS today_total
      FROM tasks WHERE user_id = $1
    `;

    const { rows } = await pool.query(sql, [userId, tz, localToday]);
    res.json({ success: true, summary: rows[0] });
  } catch (err) {
    console.error('[tasks] summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch summary' });
  }
}

// ── GET /api/tasks/nudges ──────────────────────────────────────────────────────
async function getNudges(req, res) {
  try {
    const userId = req.user.id;
    const pool = res.locals._pool;
    const now = new Date();

    const { rows } = await pool.query(
      `SELECT id, title, due_date, due_time FROM tasks
       WHERE user_id = $1 AND is_completed = false AND due_date IS NOT NULL
       ORDER BY due_date ASC, due_time ASC NULLS LAST`,
      [userId]
    );

    const nudges = rows.map(task => {
      const timeStr = task.due_time ? String(task.due_time).slice(0, 5) : null;
      let dueAtUTC;
      if (timeStr) {
        const [th, tm] = timeStr.split(':').map(Number);
        const [ty, tm2, td] = String(task.due_date).split('-').map(Number);
        dueAtUTC = new Date(Date.UTC(ty, tm2 - 1, td, th, tm, 0, 0));
      } else {
        const [ty, tm2, td] = String(task.due_date).split('-').map(Number);
        dueAtUTC = new Date(Date.UTC(ty, tm2 - 1, td + 1) - 1000);
      }

      const msUntilDue = dueAtUTC - now;
      const hoursUntilDue = msUntilDue / (1000 * 60 * 60);

      let type = '24h';
      if (msUntilDue < 0) type = 'overdue';
      else if (hoursUntilDue <= 1) type = '1h';
      else if (hoursUntilDue <= 24) type = '24h';

      return { id: task.id, title: task.title, due_date: task.due_date, due_time: timeStr, due_at: dueAtUTC.toISOString(), type };
    });

    res.json({ success: true, nudges });
  } catch (err) {
    console.error('[tasks] nudges error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch nudges' });
  }
}

// ── POST /api/tasks/suggest-steps ─────────────────────────────────────────────
async function suggestSteps(req, res) {
  try {
    const { title } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    if (!title?.trim()) return res.json({ success: true, suggestions: [], skip: true });

    const trimmedTitle = title.trim();
    const simpleVerbPattern = /^(buy|get|call|send|pay|text|pick up|drop off|schedule|book|email|message|order|print|sign|read|watch|listen|check|return|deliver|grab|fetch|remind|tell|ask|give|take|bring|clean up|tidy|wash)\b/i;
    const wordCount = trimmedTitle.split(/\b\/\b/).length;
    if (simpleVerbPattern.test(trimmedTitle) && wordCount <= 5) {
      return res.json({ success: true, suggestions: [], skip: true, reason: 'simple_task' });
    }

    const isPro = await checkProStatus(pool, userId).catch(() => false);
    if (!isPro) return res.json({ success: true, suggestions: [], skip: false, is_pro: false });

    let content;
    try {
      content = await Promise.race([
        complete({
          system: 'You are a task decomposition assistant helping people with ADHD break down tasks into concrete steps. Generate 3-5 short, specific, actionable steps. Each step must: start with an action verb, be under 10 words, be concrete not vague. Return ONLY a valid JSON array of strings, nothing else. Example: ["Open bank website and log in", "Navigate to transfers section", "Enter amount and recipient", "Confirm and save confirmation number"]',
          messages: [{ role: 'user', content: `Task: "${trimmedTitle}"\n\nGenerate 3-5 actionable steps as a JSON array.` }],
          maxTokens: 250,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {
      return res.json({ success: true, suggestions: [], skip: true, reason: 'timeout' });
    }
    let suggestions = [];
    try {
      const cleaned = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        suggestions = parsed.slice(0, 5).map(s => String(s).trim()).filter(s => s.length > 2);
      }
    } catch {
      suggestions = content.split('\n').map(line => line.replace(/^[\n\""\/\/\/]+/, '').trim()).filter(line => line.length > 3).slice(0, 5);
    }

    if (!suggestions.length) return res.json({ success: true, suggestions: [], skip: true, reason: 'no_steps' });
    res.json({ success: true, suggestions, is_pro: true });
  } catch (err) {
    console.error('[tasks] suggest-steps error:', err.message);
    res.json({ success: true, suggestions: [], skip: true, reason: 'error' });
  }
}

// ── POST /api/tasks/suggest-duration ─────────────────────────────────────────
async function suggestDuration(req, res) {
  try {
    const { title } = req.body;
    if (!title?.trim() || title.trim().length < 3) return res.json({ success: true, duration_minutes: null });

    let content;
    try {
      content = await Promise.race([
        complete({
          system: 'You are a task time estimator. Given a task title, estimate how long it will take in minutes. Be realistic. Common ranges: quick tasks 5-15 min, medium tasks 30-60 min, complex tasks 90-180 min. Return ONLY valid JSON: {"minutes": <integer>}. No explanation.',
          messages: [{ role: 'user', content: `Task: "${title.trim()}"\nHow many minutes will this take?` }],
          maxTokens: 50,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
    } catch { return res.json({ success: true, duration_minutes: null }); }
    let minutes = null;
    try {
      const cleaned = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
        minutes = Math.min(Math.round(parsed.minutes), 480);
      }
    } catch {
      const match = content.match(/\d+/);
      if (match) minutes = Math.min(parseInt(match[0]), 480);
    }

    res.json({ success: true, duration_minutes: minutes });
  } catch (_err) {
    res.json({ success: true, duration_minutes: null });
  }
}

// ── GET /api/tasks/:id ────────────────────────────────────────────────────────
async function getTask(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const sql = `
      SELECT t.*,
        COALESCE(json_agg(json_build_object(
          'id', s.id, 'task_id', s.task_id, 'title', s.title,
          'is_completed', s.is_completed, 'sort_order', s.sort_order,
          'completed_at', s.completed_at, 'created_at', s.created_at
        ) ORDER BY s.sort_order) FILTER (WHERE s.id IS NOT NULL), '[]') AS steps
      FROM tasks t
      LEFT JOIN task_steps s ON s.task_id = t.id
      WHERE t.id = $1 AND t.user_id = $2
      GROUP BY t.id
    `;

    const { rows } = await pool.query(sql, [parseInt(id), userId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, task: normTask(rows[0]) });
  } catch (err) {
    console.error('[tasks] get error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch task' });
  }
}

// ── POST /api/tasks ────────────────────────────────────────────────────────────
async function createTask(req, res) {
  try {
    const { title, description, priority, due_date, due_time, steps, source, merchant_hint,
            expected_amount, duration_minutes, is_household, is_shared_with_partner,
            recurrence_type, recurrence_day } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    if (!title?.trim()) return res.status(400).json({ success: false, message: 'What should this task be called?' });
    if (title.trim().length > 150) return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });

    // Free user task limit check
    try {
      const isPro = await checkProStatus(pool, userId);
      if (!isPro) {
        const { rows: countRows } = await pool.query(
          'SELECT COUNT(*)::int AS c FROM tasks WHERE user_id = $1 AND is_completed = false',
          [userId]
        );
        if (countRows[0].c >= 10) {
          return res.status(402).json({ success: false, message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Autopilot.', code: 'TASK_LIMIT_REACHED', upgrade_required: true });
        }
      }
    } catch (subErr) {
      console.error('[tasks] subscription check failed, treating as free:', subErr.message);
      try {
        const { rows: countRows } = await pool.query(
          'SELECT COUNT(*)::int AS c FROM tasks WHERE user_id = $1 AND is_completed = false',
          [userId]
        );
        if (countRows[0].c >= 10) {
          return res.status(402).json({ success: false, message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Autopilot.', code: 'TASK_LIMIT_REACHED', upgrade_required: true });
        }
      } catch { /* full DB outage — let creation attempt proceed */ }
    }

    // Auto-tag to value
    let autoValueId = null;
    try {
      const { matchTaskToValue } = require('../lib/auto-tagger');
      autoValueId = await matchTaskToValue(pool, userId, title.trim());
    } catch (e) {
      console.warn('[tasks] auto-tag failed:', e.message);
    }

    const durationMins = duration_minutes ? parseInt(duration_minutes) : null;
    const recType = recurrence_type || 'none';
    const recDay = (recType && recType !== 'none' && recType !== 'daily' && recType !== 'weekdays' && recurrence_day != null)
      ? parseInt(recurrence_day)
      : null;

    // Build INSERT dynamically to skip columns that may not exist in older DB schemas
    const cols = ['user_id', 'title', 'priority', 'source'];
    const vals = [userId, title.trim(), priority || 'medium', source || 'manual'];
    let idx = vals.length;

    function addCol(col, val) {
      cols.push(col);
      vals.push(val);
      idx++;
    }

    if (description)           addCol('description', description);
    if (due_date)              addCol('due_date', due_date);
    if (due_time)              addCol('due_time', due_time);
    if (merchant_hint)         addCol('merchant_hint', merchant_hint);
    if (expected_amount != null) addCol('expected_amount', parseFloat(expected_amount));
    if (autoValueId != null)   addCol('value_id', autoValueId);
    if (durationMins != null)  addCol('duration_minutes', durationMins);
    if (durationMins != null)  addCol('duration_source', 'manual');
    if (is_household != null)  addCol('is_household', Boolean(is_household));
    if (is_shared_with_partner != null) addCol('is_shared_with_partner', Boolean(is_shared_with_partner));
    addCol('recurrence_type', recType);
    if (recDay != null)        addCol('recurrence_day', recDay);

    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const insertSql = `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;

    let taskRow;
    try {
      const { rows } = await pool.query(insertSql, vals);
      taskRow = rows[0];
    } catch (insertErr) {
      if (insertErr.code === '42703') {
        // Retry with minimal columns if an optional column doesn't exist
        const minSql = `INSERT INTO tasks (user_id, title, priority, source) VALUES ($1, $2, $3, $4) RETURNING *`;
        const { rows } = await pool.query(minSql, [userId, title.trim(), priority || 'medium', source || 'manual']);
        taskRow = rows[0];
      } else {
        throw insertErr;
      }
    }

    // Insert steps if provided
    if (steps?.length > 0) {
      for (let i = 0; i < steps.length; i++) {
        await pool.query(
          'INSERT INTO task_steps (task_id, title, sort_order) VALUES ($1, $2, $3)',
          [taskRow.id, steps[i].trim(), i]
        );
      }
    }

    // Re-fetch with steps
    const fetchSql = `
      SELECT t.*,
        COALESCE(json_agg(json_build_object(
          'id', s.id, 'task_id', s.task_id, 'title', s.title,
          'is_completed', s.is_completed, 'sort_order', s.sort_order,
          'completed_at', s.completed_at, 'created_at', s.created_at
        ) ORDER BY s.sort_order) FILTER (WHERE s.id IS NOT NULL), '[]') AS steps
      FROM tasks t
      LEFT JOIN task_steps s ON s.task_id = t.id
      WHERE t.id = $1
      GROUP BY t.id
    `;
    const { rows: fullRows } = await pool.query(fetchSql, [taskRow.id]);
    const fullTask = fullRows[0] || taskRow;

    res.status(201).json({ success: true, task: normTask(fullTask) });

    // Fire-and-forget: AI duration suggestion
    if (!durationMins) {
      setImmediate(async () => {
        try {
          const raw = await Promise.race([
            complete({
              system: 'Estimate task duration in minutes. Return ONLY valid JSON: {"minutes": <integer>}. Ranges: quick 5-15, medium 30-60, complex 90-180. No explanation.',
              messages: [{ role: 'user', content: `Task: "${title.trim()}"` }],
              maxTokens: 50,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
            await pool.query(
              'UPDATE tasks SET duration_minutes = $1, duration_source = $2 WHERE id = $3',
              [Math.min(Math.round(parsed.minutes), 480), 'ai', taskRow.id]
            );
          }
        } catch { /* silent */ }
      });
    }
  } catch (err) {
    console.error('[tasks] create error:', err);
    res.status(500).json({ success: false, message: 'Failed to create task' });
  }
}

// ── PATCH /api/tasks/:id ──────────────────────────────────────────────────────
async function updateTask(req, res) {
  try {
    const { id } = req.params;
    const { due_date, due_time, title, value_id, notes, is_household, is_shared_with_partner, is_completed,
            recurrence_type, recurrence_day } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    if (title !== undefined && title.trim().length > 150) {
      return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });
    }

    const setCols = [];
    const vals = [];
    let idx = 1;

    function addSet(col, val) {
      setCols.push(`${col} = $${idx++}`);
      vals.push(val);
    }

    if (due_date !== undefined)  addSet('due_date', due_date || null);
    if (due_time !== undefined)  addSet('due_time', due_time || null);
    if (title !== undefined && title.trim()) addSet('title', title.trim());
    if (value_id !== undefined)  addSet('value_id', (!value_id || value_id === 0) ? null : parseInt(value_id));
    if (notes !== undefined)     addSet('notes', notes === '' ? null : notes);
    if (is_household !== undefined) addSet('is_household', Boolean(is_household));
    if (is_shared_with_partner !== undefined) addSet('is_shared_with_partner', Boolean(is_shared_with_partner));
    if (is_completed !== undefined) {
      addSet('is_completed', Boolean(is_completed));
      addSet('completed_at', is_completed ? new Date() : null);
    }
    if (recurrence_type !== undefined) {
      addSet('recurrence_type', recurrence_type);
    }
    if (recurrence_type !== undefined) {
      if (recurrence_type && recurrence_type !== 'none' && recurrence_type !== 'daily' && recurrence_type !== 'weekdays') {
        if (recurrence_day !== undefined) addSet('recurrence_day', recurrence_day != null ? parseInt(recurrence_day) : null);
      } else {
        addSet('recurrence_day', null);
      }
    }
    addSet('updated_at', new Date());

    if (setCols.length <= 1) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    vals.push(parseInt(id), userId);
    const sql = `UPDATE tasks SET ${setCols.join(', ')} WHERE id = $${idx++} AND user_id = $${idx++} RETURNING *`;

    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, task: normTask(rows[0]) });
  } catch (err) {
    if (err.code === '42703') return res.status(500).json({ success: false, message: 'Column does not exist: ' + err.message });
    console.error('[tasks] update error:', err);
    res.status(500).json({ success: false, message: 'Failed to update task' });
  }
}

// ── PATCH /api/tasks/:id/toggle ───────────────────────────────────────────────
async function toggleTask(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const { rows: existing } = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(id), userId]
    );
    if (!existing.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const task_before = existing[0];
    const newCompleted = !task_before.is_completed;

    const { rows: updated } = await pool.query(
      'UPDATE tasks SET is_completed = $1, completed_at = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
      [newCompleted, newCompleted ? new Date() : null, parseInt(id), userId]
    );
    const task = updated[0];

    if (newCompleted) {
      await pool.query(
        'UPDATE task_steps SET is_completed = true, completed_at = NOW() WHERE task_id = $1',
        [parseInt(id)]
      );
    }

    // Spawn next occurrence if completing a recurring task
    let nextRecurring = null;
    if (newCompleted && task_before.recurrence_type && task_before.recurrence_type !== 'none') {
      try {
        const nextData = spawnNextOccurrence(task_before, userId);
        if (nextData) {
          const cols = ['user_id', 'title', 'priority', 'source', 'recurrence_type'];
          const vals = [nextData.user_id, nextData.title, nextData.priority, nextData.source, nextData.recurrence_type];
          let idx = vals.length;

          function addC(col, val) { cols.push(col); vals.push(val); idx++; }
          if (nextData.description)    addC('description', nextData.description);
          if (nextData.due_date)       addC('due_date', nextData.due_date);
          if (nextData.due_time)       addC('due_time', nextData.due_time);
          if (nextData.value_id)       addC('value_id', nextData.value_id);
          if (nextData.notes)          addC('notes', nextData.notes);
          if (nextData.recurrence_day != null) addC('recurrence_day', nextData.recurrence_day);

          const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
          const { rows: nextRows } = await pool.query(
            `INSERT INTO tasks (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
            vals
          );
          nextRecurring = normTask(nextRows[0]);
        }
      } catch (spawnErr) {
        console.error('[tasks] failed to spawn next occurrence:', spawnErr.message);
      }
    }

    res.json({ success: true, task: normTask(task), next_recurring_task: nextRecurring });
  } catch (err) {
    console.error('[tasks] toggle error:', err);
    res.status(500).json({ success: false, message: 'Failed to toggle task' });
  }
}

// ── PATCH /api/tasks/:id/duration ─────────────────────────────────────────────
async function updateDuration(req, res) {
  try {
    const { id } = req.params;
    const { duration_minutes } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const mins = duration_minutes === null || duration_minutes === undefined ? null : parseInt(duration_minutes);
    if (mins !== null && (isNaN(mins) || mins < 1 || mins > 1440)) {
      return res.status(400).json({ success: false, message: 'Duration must be between 1 and 1440 minutes.' });
    }

    const { rows } = await pool.query(
      'UPDATE tasks SET duration_minutes = $1, duration_source = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4 RETURNING *',
      [mins, mins === null ? null : 'manual', parseInt(id), userId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, task: normTask(rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update duration' });
  }
}

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────
async function deleteTask(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const { rowCount } = await pool.query(
      'DELETE FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(id), userId]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks] delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete task' });
  }
}

// ── GET /api/tasks/streak ────────────────────────────────────────────────────
async function getStreak(req, res) {
  try {
    const userId = req.user.id;
    const pool = res.locals._pool;

    let streak = null;
    try {
      const { rows } = await pool.query(
        'SELECT * FROM morning_streaks WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      streak = rows[0] || null;
    } catch (tableErr) {
      // Table may not exist in all DB versions
      if (tableErr.code !== '42P01') throw tableErr;
    }

    res.json({
      success: true,
      current_streak: streak?.current_streak ?? 0,
      longest_streak: streak?.longest_streak ?? 0,
      last_completed_date: streak?.last_completed_date ?? null,
    });
  } catch (err) {
    console.error('[tasks] streak error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch streak' });
  }
}

// ── POST /api/tasks/:taskId/steps ─────────────────────────────────────────────
async function addStep(req, res) {
  try {
    const { taskId } = req.params;
    const { title } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });

    const { rows: taskRows } = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(taskId), userId]
    );
    if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found' });

    const { rows: maxRows } = await pool.query(
      'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM task_steps WHERE task_id = $1',
      [parseInt(taskId)]
    );
    const nextOrder = (maxRows[0].max_order ?? -1) + 1;

    const { rows } = await pool.query(
      'INSERT INTO task_steps (task_id, title, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [parseInt(taskId), title.trim(), nextOrder]
    );

    res.status(201).json({ success: true, step: rows[0] });
  } catch (err) {
    console.error('[tasks] addStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to add step' });
  }
}

// ── PATCH /api/tasks/:taskId/steps/:stepId ─────────────────────────────────────
async function updateStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const { title, sort_order } = req.body;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const { rows: taskRows } = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(taskId), userId]
    );
    if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found' });

    const setCols = [];
    const vals = [];
    let idx = 1;

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      setCols.push(`title = $${idx++}`); vals.push(title.trim());
    }
    if (sort_order !== undefined) { setCols.push(`sort_order = $${idx++}`); vals.push(sort_order); }

    if (!setCols.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    vals.push(parseInt(stepId), parseInt(taskId));
    const sql = `UPDATE task_steps SET ${setCols.join(', ')} WHERE id = $${idx++} AND task_id = $${idx++} RETURNING *`;

    const { rows } = await pool.query(sql, vals);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Step not found' });
    res.json({ success: true, step: rows[0] });
  } catch (err) {
    console.error('[tasks] updateStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to update step' });
  }
}

// ── PATCH /api/tasks/:taskId/steps/:stepId/toggle ──────────────────────────────
async function toggleStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const { rows: taskRows } = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(taskId), userId]
    );
    if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const task = taskRows[0];

    const { rows: existingRows } = await pool.query(
      'SELECT * FROM task_steps WHERE id = $1 AND task_id = $2',
      [parseInt(stepId), parseInt(taskId)]
    );
    if (!existingRows.length) return res.status(404).json({ success: false, message: 'Step not found' });
    const existing = existingRows[0];
    const newCompleted = !existing.is_completed;

    const { rows: stepRows } = await pool.query(
      'UPDATE task_steps SET is_completed = $1, completed_at = $2 WHERE id = $3 AND task_id = $4 RETURNING *',
      [newCompleted, newCompleted ? new Date() : null, parseInt(stepId), parseInt(taskId)]
    );
    const step = stepRows[0];

    // Auto-complete/uncomplete parent task based on steps state
    const { rows: allSteps } = await pool.query(
      'SELECT is_completed FROM task_steps WHERE task_id = $1',
      [parseInt(taskId)]
    );
    const allDone = allSteps.length > 0 && allSteps.every(s => s.is_completed);
    const noneDone = allSteps.every(s => !s.is_completed);

    if (allDone) {
      await pool.query(
        'UPDATE tasks SET is_completed = true, completed_at = NOW() WHERE id = $1',
        [parseInt(taskId)]
      );
    } else if (noneDone && task.is_completed) {
      await pool.query(
        'UPDATE tasks SET is_completed = false, completed_at = NULL WHERE id = $1',
        [parseInt(taskId)]
      );
    }

    res.json({ success: true, step, next_recurring_task: null });
  } catch (err) {
    console.error('[tasks] toggleStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to toggle step' });
  }
}

// ── DELETE /api/tasks/:taskId/steps/:stepId ────────────────────────────────────
async function deleteStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const userId = req.user.id;
    const pool = res.locals._pool;

    const { rows: taskRows } = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
      [parseInt(taskId), userId]
    );
    if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found' });

    const { rowCount } = await pool.query(
      'DELETE FROM task_steps WHERE id = $1 AND task_id = $2',
      [parseInt(stepId), parseInt(taskId)]
    );
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Step not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks] deleteStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete step' });
  }
}

// ── Re-entry Brief ────────────────────────────────────────────────────────────
const REENTRY_THRESHOLD_DAYS = 5;

async function getReentryBrief(req, res) {
  try {
    const taskId = parseInt(req.params.id);
    const userId = req.user.id;
    const pool = res.locals._pool;
    if (isNaN(taskId)) return res.status(400).json({ success: false, message: 'Invalid task id' });

    const { rows: taskRows } = await pool.query(
      'SELECT id, title, notes, created_at, is_completed FROM tasks WHERE id = $1 AND user_id = $2',
      [taskId, userId]
    );
    if (!taskRows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const task = taskRows[0];

    const [sessionResult, substepResult] = await Promise.all([
      pool.query(
        'SELECT started_at, actual_duration_seconds FROM focus_sessions WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1',
        [taskId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        'SELECT title FROM task_substeps WHERE task_id = $1 AND is_completed = false ORDER BY sort_order ASC LIMIT 1',
        [taskId]
      ).catch(() => ({ rows: [] })),
    ]);

    const lastSession = sessionResult.rows[0] || null;
    const nextSubstep = substepResult.rows[0] || null;

    const now = new Date();
    const referenceDate = lastSession ? new Date(lastSession.started_at) : new Date(task.created_at);
    const daysSince = (now - referenceDate) / (1000 * 60 * 60 * 24);

    if (daysSince < REENTRY_THRESHOLD_DAYS) {
      return res.json({ success: true, brief: null });
    }

    return res.json({
      success: true,
      brief: {
        lastWorkedOn: lastSession ? lastSession.started_at : null,
        daysSince: Math.floor(daysSince),
        lastNote: task.notes ? task.notes.slice(0, 150) : null,
        nextSubstep: nextSubstep ? nextSubstep.title : null,
      },
    });
  } catch (err) {
    console.error('[tasks] getReentryBrief error:', err);
    res.status(500).json({ success: false, message: 'Failed to load brief' });
  }
}

// ── Mount on Express Router ───────────────────────────────────────────────────
module.exports = function(pool) {
  const router = require('express').Router();

  // Attach pool to res.locals so all handlers can access it without closure
  router.use((req, res, next) => { res.locals._pool = pool; next(); });
  router.use(authMW);

  router.get('/', listTasks);
  router.get('/summary', getSummary);
  router.get('/streak', getStreak);
  router.get('/nudges', getNudges);
  router.post('/suggest-steps', suggestSteps);
  router.post('/suggest-duration', suggestDuration);
  router.post('/', createTask);

  // Must be before /:id to avoid Express treating "reentry-brief" as the id param
  router.get('/:id/reentry-brief', getReentryBrief);

  router.get('/:id', getTask);
  router.patch('/:id', updateTask);
  router.patch('/:id/toggle', toggleTask);
  router.patch('/:id/duration', updateDuration);
  router.delete('/:id', deleteTask);

  router.post('/:taskId/steps', addStep);
  router.patch('/:taskId/steps/:stepId', updateStep);
  router.patch('/:taskId/steps/:stepId/toggle', toggleStep);
  router.delete('/:taskId/steps/:stepId', deleteStep);

  return router;
};
