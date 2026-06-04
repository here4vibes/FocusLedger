// Phase 3A: Tasks CRUD backed by Prisma.
// Owns: task CRUD, steps CRUD, summary, nudges, suggest-steps, suggest-duration.
// Does NOT own: auth middleware, pro status check, recurring task spawning.
const { prisma } = require('../lib/prisma');
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const OpenAI = require('openai');

// ── Helpers: time string ↔ Date conversion (Prisma @db.Time returns Date) ───
// DB stores time as 'time without time zone'; Prisma maps it to DateTime @db.Time.
// Frontend sends/expects "HH:MM" strings — these helpers bridge the gap.
function timeStrToDate(str) {
  if (!str) return null;
  if (str instanceof Date) return str;
  const [h, m] = String(str).split(':').map(Number);
  if (isNaN(h)) return null;
  return new Date(Date.UTC(1970, 0, 1, h, m || 0, 0));
}

function dateToTimeStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d; // already a string
  if (d instanceof Date) {
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }
  return null;
}

// Normalize task object: convert due_time Date back to "HH:MM" string for API consumers
// Also ensure recurrence_type is present (defaults to "none" for existing rows)
function normTask(t) {
  if (!t) return t;
  return {
    ...t,
    due_time: dateToTimeStr(t.due_time),
    recurrence_type: t.recurrence_type || 'none',
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
    // Mon-Fri: find next weekday
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
    due_time: task.due_time,
    source: 'recurring',
    recurring_task_id: null,
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

    const where = { user_id: userId };
    if (filter === 'active') where.is_completed = false;
    else if (filter === 'completed') where.is_completed = true;

    const orderBy = sort === 'due_date'
      ? [{ is_completed: 'asc' }, { due_date: 'asc' }, { due_time: 'asc' }, { created_at: 'desc' }]
      : [{ is_completed: 'asc' }, { created_at: 'desc' }];

    const tasks = await prisma.task.findMany({
      where,
      orderBy,
      include: { steps: { orderBy: { sort_order: 'asc' } } },
    });

    // Count steps in JS; normalize due_time to "HH:MM" string
    const enriched = tasks.map(t => ({
      ...normTask(t),
      total_steps: t.steps.length,
      completed_steps: t.steps.filter(s => s.is_completed).length,
    }));

    res.json({ success: true, tasks: enriched });
  } catch (err) {
    console.error('[tasks-prisma] list error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

// ── GET /api/tasks/summary ────────────────────────────────────────────────────
async function getSummary(req, res) {
  try {
    const userId = req.user.id;
    const tz = await fetchUserTimezone(prisma.pool, userId);
    const localToday = getUserLocalDate(tz);

    const [all] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                  AS total,
        COUNT(*) FILTER (WHERE NOT is_completed)::int  AS active_tasks,
        COUNT(*) FILTER (WHERE is_completed)::int      AS completed_tasks,
        COUNT(*) FILTER (WHERE is_completed AND (completed_at AT TIME ZONE ${tz})::date = ${localToday}::date)::int AS completed_today,
        COUNT(*) FILTER (WHERE is_completed AND completed_at >= NOW() - INTERVAL '7 days')::int AS completed_this_week,
        COUNT(*) FILTER (WHERE due_date = ${localToday}::date AND NOT is_completed)::int AS due_today,
        COUNT(*) FILTER (WHERE due_date < ${localToday}::date AND NOT is_completed)::int AS overdue,
        COUNT(*) FILTER (WHERE
          due_date::date = ${localToday}::date
          OR (due_date::date < ${localToday}::date AND NOT is_completed)
          OR (due_date IS NULL AND (created_at AT TIME ZONE ${tz})::date = ${localToday}::date AND NOT is_completed)
          OR (is_completed AND (completed_at AT TIME ZONE ${tz})::date = ${localToday}::date)
        )::int AS today_total
      FROM tasks WHERE user_id = ${userId}
    `;

    res.json({ success: true, summary: all });
  } catch (err) {
    console.error('[tasks-prisma] summary error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch summary' });
  }
}

// ── GET /api/tasks/nudges ──────────────────────────────────────────────────────
async function getNudges(req, res) {
  try {
    const userId = req.user.id;
    const now = new Date();

    const tasks = await prisma.task.findMany({
      where: { user_id: userId, is_completed: false, due_date: { not: null } },
      orderBy: [{ due_date: 'asc' }, { due_time: 'asc' }],
      select: { id: true, title: true, due_date: true, due_time: true },
    });

    const nudges = tasks.map(task => {
      const timeStr = dateToTimeStr(task.due_time);
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
    console.error('[tasks-prisma] nudges error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch nudges' });
  }
}

// ── POST /api/tasks/suggest-steps ─────────────────────────────────────────────
async function suggestSteps(req, res) {
  try {
    const { title } = req.body;
    const userId = req.user.id;

    if (!title?.trim()) return res.json({ success: true, suggestions: [], skip: true });

    const trimmedTitle = title.trim();
    const simpleVerbPattern = /^(buy|get|call|send|pay|text|pick up|drop off|schedule|book|email|message|order|print|sign|read|watch|listen|check|return|deliver|grab|fetch|remind|tell|ask|give|take|bring|clean up|tidy|wash)\b/i;
    const wordCount = trimmedTitle.split(/\b\/\b/).length;
    if (simpleVerbPattern.test(trimmedTitle) && wordCount <= 5) {
      return res.json({ success: true, suggestions: [], skip: true, reason: 'simple_task' });
    }

    let isPro = false;
    try { isPro = await checkProStatus(prisma, userId); } catch (_e) { isPro = false; }
    if (!isPro) return res.json({ success: true, suggestions: [], skip: false, is_pro: false });

    const openai = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });

    let completion;
    try {
      completion = await Promise.race([
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a task decomposition assistant helping people with ADHD break down tasks into concrete steps. Generate 3-5 short, specific, actionable steps. Each step must: start with an action verb, be under 10 words, be concrete not vague. Return ONLY a valid JSON array of strings, nothing else. Example: ["Open bank website and log in", "Navigate to transfers section", "Enter amount and recipient", "Confirm and save confirmation number"]' },
            { role: 'user', content: `Task: "${trimmedTitle}"\n\nGenerate 3-5 actionable steps as a JSON array.` },
          ],
          max_tokens: 250, temperature: 0.6,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
    } catch {
      return res.json({ success: true, suggestions: [], skip: true, reason: 'timeout' });
    }

    const content = (completion.choices[0].message.content || '').trim();
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
    console.error('[tasks-prisma] suggest-steps error:', err.message);
    res.json({ success: true, suggestions: [], skip: true, reason: 'error' });
  }
}

// ── POST /api/tasks/suggest-duration ─────────────────────────────────────────
async function suggestDuration(req, res) {
  try {
    const { title } = req.body;
    if (!title?.trim() || title.trim().length < 3) return res.json({ success: true, duration_minutes: null });

    const openai = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });
    let completion;
    try {
      completion = await Promise.race([
        openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a task time estimator. Given a task title, estimate how long it will take in minutes. Be realistic. Common ranges: quick tasks 5-15 min, medium tasks 30-60 min, complex tasks 90-180 min. Return ONLY a JSON object: {"minutes": <integer>}. No explanation.' },
            { role: 'user', content: `Task: "${title.trim()}"\nHow many minutes will this take?` },
          ],
          max_tokens: 50, temperature: 0.3,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
    } catch { return res.json({ success: true, duration_minutes: null }); }

    const content = (completion.choices[0].message.content || '').trim();
    let minutes = null;
    try {
      const cleaned = content.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
        minutes = Math.min(Math.round(parsed.minutes), 480);
      }
    } catch {
      const match = content.match(/\n\//);
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

    const task = await prisma.task.findFirst({
      where: { id: parseInt(id), user_id: userId },
      include: { steps: { orderBy: { sort_order: 'asc' } } },
    });

    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });
    res.json({ success: true, task: normTask(task) });
  } catch (err) {
    console.error('[tasks-prisma] get error:', err);
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

    if (!title?.trim()) return res.status(400).json({ success: false, message: 'What should this task be called?' });
    if (title.trim().length > 150) return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });

    // Free user task limit check
    try {
      const isPro = await checkProStatus(prisma, userId);
      if (!isPro) {
        const activeCount = await prisma.task.count({ where: { user_id: userId, is_completed: false } });
        if (activeCount >= 10) {
          return res.status(402).json({ success: false, message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Autopilot.', code: 'TASK_LIMIT_REACHED', upgrade_required: true });
        }
      }
    } catch (subErr) {
      console.error('[tasks-prisma] subscription check failed:', subErr.message);
      return res.status(500).json({ success: false, message: 'Unable to verify subscription status.', code: 'SUBSCRIPTION_CHECK_FAILED' });
    }

    // Auto-tag to value
    let autoValueId = null;
    try {
      const { matchTaskToValue } = require('../lib/auto-tagger');
      autoValueId = await matchTaskToValue(prisma.pool, userId, title.trim());
    } catch (e) {
      console.warn('[tasks-prisma] auto-tag failed:', e.message);
    }

    const durationMins = duration_minutes ? parseInt(duration_minutes) : null;

    const task = await prisma.task.create({
      data: {
        user_id: userId,
        title: title.trim(),
        description: description || null,
        priority: priority || 'medium',
        due_date: due_date ? new Date(due_date) : null,
        due_time: timeStrToDate(due_time),
        source: source || 'manual',
        merchant_hint: merchant_hint || null,
        expected_amount: expected_amount ? parseFloat(expected_amount) : null,
        value_id: autoValueId,
        duration_minutes: durationMins,
        duration_source: durationMins ? 'manual' : null,
        is_household: Boolean(is_household),
        is_shared_with_partner: Boolean(is_shared_with_partner),
        recurrence_type: recurrence_type || 'none',
        recurrence_day: recurrence_type && recurrence_type !== 'none' && recurrence_type !== 'daily' && recurrence_type !== 'weekdays'
          ? (recurrence_day != null ? parseInt(recurrence_day) : null)
          : null,
      },
      include: { steps: { orderBy: { sort_order: 'asc' } } },
    });

    // Insert steps if provided
    if (steps?.length > 0) {
      const stepData = steps.map((s, i) => ({ task_id: task.id, title: s.trim(), sort_order: i }));
      await prisma.task_step.createMany({ data: stepData });
    }

    // Re-fetch with steps
    const fullTask = await prisma.task.findUnique({
      where: { id: task.id },
      include: { steps: { orderBy: { sort_order: 'asc' } } },
    });

    res.status(201).json({ success: true, task: normTask(fullTask || task) });

    // Fire-and-forget: AI duration suggestion
    if (!durationMins) {
      setImmediate(async () => {
        try {
          const openai = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY });
          const completion = await Promise.race([
            openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: 'Estimate task duration in minutes. Return ONLY JSON: {"minutes": <integer>}. Ranges: quick 5-15, medium 30-60, complex 90-180. No explanation.' },
                { role: 'user', content: `Task: "${title.trim()}"` },
              ],
              max_tokens: 50, temperature: 0.3,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
          const raw = (completion.choices[0].message.content || '').trim().replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.minutes === 'number' && parsed.minutes > 0) {
            await prisma.task.update({ where: { id: task.id }, data: { duration_minutes: Math.min(Math.round(parsed.minutes), 480), duration_source: 'ai' } });
          }
        } catch { /* silent */ }
      });
    }
  } catch (err) {
    console.error('[tasks-prisma] create error:', err);
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

    if (title !== undefined && title.trim().length > 150) {
      return res.status(400).json({ success: false, message: 'Task title must be 150 characters or fewer.' });
    }

    const data = {};
    if (due_date !== undefined)         data.due_date = due_date ? new Date(due_date) : null;
    if (due_time !== undefined)         data.due_time = timeStrToDate(due_time);
    if (title !== undefined && title.trim()) data.title = title.trim();
    if (value_id !== undefined)         data.value_id = (!value_id || value_id === 0) ? null : parseInt(value_id);
    if (notes !== undefined)            data.notes = notes === '' ? null : notes;
    if (is_household !== undefined)     data.is_household = Boolean(is_household);
    if (is_shared_with_partner !== undefined) data.is_shared_with_partner = Boolean(is_shared_with_partner);
    if (is_completed !== undefined) {
      data.is_completed = Boolean(is_completed);
      data.completed_at = is_completed ? new Date() : null;
    }
    if (recurrence_type !== undefined) {
      data.recurrence_type = recurrence_type;
    }
    if (recurrence_type && recurrence_type !== 'none' && recurrence_type !== 'daily' && recurrence_type !== 'weekdays') {
      if (recurrence_day !== undefined) data.recurrence_day = recurrence_day != null ? parseInt(recurrence_day) : null;
    } else if (recurrence_type === 'none' || recurrence_type === 'daily' || recurrence_type === 'weekdays') {
      data.recurrence_day = null;
    }
    data.updated_at = new Date();

    if (Object.keys(data).length <= 1 && !data.updated_at) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    const task = await prisma.task.update({
      where: { id: parseInt(id), user_id: userId },
      data,
    });

    res.json({ success: true, task: normTask(task) });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Task not found' });
    console.error('[tasks-prisma] update error:', err);
    res.status(500).json({ success: false, message: 'Failed to update task' });
  }
}

// ── PATCH /api/tasks/:id/toggle ───────────────────────────────────────────────
async function toggleTask(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const existing = await prisma.task.findFirst({ where: { id: parseInt(id), user_id: userId } });
    if (!existing) return res.status(404).json({ success: false, message: 'Task not found' });

    const task = await prisma.task.update({
      where: { id: parseInt(id), user_id: userId },
      data: { is_completed: !existing.is_completed, completed_at: !existing.is_completed ? new Date() : null, updated_at: new Date() },
    });

    if (task.is_completed) {
      await prisma.task_step.updateMany({ where: { task_id: parseInt(id) }, data: { is_completed: true, completed_at: new Date() } });
    }

    // Spawn next occurrence if completing a recurring task
    let nextRecurring = null;
    if (task.is_completed && existing.recurrence_type && existing.recurrence_type !== 'none') {
      try {
        const nextData = spawnNextOccurrence(existing, userId);
        if (nextData) {
          const nextTask = await prisma.task.create({ data: nextData });
          nextRecurring = normTask(nextTask);
        }
      } catch (spawnErr) {
        console.error('[tasks-prisma] failed to spawn next occurrence:', spawnErr.message);
      }
    }

    res.json({ success: true, task: normTask(task), next_recurring_task: nextRecurring });
  } catch (err) {
    console.error('[tasks-prisma] toggle error:', err);
    res.status(500).json({ success: false, message: 'Failed to toggle task' });
  }
}

// ── PATCH /api/tasks/:id/duration ─────────────────────────────────────────────
async function updateDuration(req, res) {
  try {
    const { id } = req.params;
    const { duration_minutes } = req.body;
    const userId = req.user.id;

    const mins = duration_minutes === null || duration_minutes === undefined ? null : parseInt(duration_minutes);
    if (mins !== null && (isNaN(mins) || mins < 1 || mins > 1440)) {
      return res.status(400).json({ success: false, message: 'Duration must be between 1 and 1440 minutes.' });
    }

    const task = await prisma.task.update({
      where: { id: parseInt(id), user_id: userId },
      data: { duration_minutes: mins, duration_source: mins === null ? null : 'manual', updated_at: new Date() },
    });

    res.json({ success: true, task: normTask(task) });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Task not found' });
    res.status(500).json({ success: false, message: 'Failed to update duration' });
  }
}

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────────
async function deleteTask(req, res) {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    await prisma.task.delete({ where: { id: parseInt(id), user_id: userId } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Task not found' });
    console.error('[tasks-prisma] delete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete task' });
  }
}

// ── GET /api/tasks/streak ────────────────────────────────────────────────────
async function getStreak(req, res) {
  try {
    const userId = req.user.id;
    const streak = await prisma.morning_streaks.findUnique({ where: { user_id: userId } });
    res.json({
      success: true,
      current_streak: streak?.current_streak ?? 0,
      longest_streak: streak?.longest_streak ?? 0,
      last_completed_date: streak?.last_completed_date ?? null,
    });
  } catch (err) {
    console.error('[tasks-prisma] streak error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch streak' });
  }
}

// ── POST /api/tasks/:taskId/steps ─────────────────────────────────────────────
async function addStep(req, res) {
  try {
    const { taskId } = req.params;
    const { title } = req.body;
    const userId = req.user.id;

    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });

    const task = await prisma.task.findFirst({ where: { id: parseInt(taskId), user_id: userId } });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const maxOrder = await prisma.task_step.aggregate({ where: { task_id: parseInt(taskId) }, _max: { sort_order: true } });

    const step = await prisma.task_step.create({
      data: { task_id: parseInt(taskId), title: title.trim(), sort_order: (maxOrder._max.sort_order ?? -1) + 1 },
    });

    res.status(201).json({ success: true, step });
  } catch (err) {
    console.error('[tasks-prisma] addStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to add step' });
  }
}

// ── PATCH /api/tasks/:taskId/steps/:stepId ─────────────────────────────────────
async function updateStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const { title, sort_order } = req.body;
    const userId = req.user.id;

    const task = await prisma.task.findFirst({ where: { id: parseInt(taskId), user_id: userId } });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const data = {};
    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ success: false, message: 'Title cannot be empty' });
      data.title = title.trim();
    }
    if (sort_order !== undefined) data.sort_order = sort_order;

    if (!Object.keys(data).length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    const step = await prisma.task_step.update({
      where: { id: parseInt(stepId), task_id: parseInt(taskId) },
      data,
    });

    res.json({ success: true, step });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Step not found' });
    console.error('[tasks-prisma] updateStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to update step' });
  }
}

// ── PATCH /api/tasks/:taskId/steps/:stepId/toggle ──────────────────────────────
async function toggleStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const userId = req.user.id;

    const task = await prisma.task.findFirst({ where: { id: parseInt(taskId), user_id: userId } });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    const existing = await prisma.task_step.findFirst({ where: { id: parseInt(stepId), task_id: parseInt(taskId) } });
    if (!existing) return res.status(404).json({ success: false, message: 'Step not found' });

    const step = await prisma.task_step.update({
      where: { id: parseInt(stepId), task_id: parseInt(taskId) },
      data: { is_completed: !existing.is_completed, completed_at: !existing.is_completed ? new Date() : null },
    });

    // Auto-complete parent task if all steps done; uncomplete if step unchecked
    const allSteps = await prisma.task_step.findMany({ where: { task_id: parseInt(taskId) } });
    const allDone = allSteps.length > 0 && allSteps.every(s => s.is_completed);
    const noneDone = allSteps.every(s => !s.is_completed);

    if (allDone) {
      await prisma.task.update({ where: { id: parseInt(taskId) }, data: { is_completed: true, completed_at: new Date() } });
    } else if (noneDone && task.is_completed) {
      await prisma.task.update({ where: { id: parseInt(taskId) }, data: { is_completed: false, completed_at: null } });
    }

    res.json({ success: true, step, next_recurring_task: null });
  } catch (err) {
    console.error('[tasks-prisma] toggleStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to toggle step' });
  }
}

// ── DELETE /api/tasks/:taskId/steps/:stepId ────────────────────────────────────
async function deleteStep(req, res) {
  try {
    const { taskId, stepId } = req.params;
    const userId = req.user.id;

    const task = await prisma.task.findFirst({ where: { id: parseInt(taskId), user_id: userId } });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

    await prisma.task_step.delete({ where: { id: parseInt(stepId), task_id: parseInt(taskId) } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ success: false, message: 'Step not found' });
    console.error('[tasks-prisma] deleteStep error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete step' });
  }
}

// ── Mount on Express Router ───────────────────────────────────────────────────
module.exports = function() {
  const router = require('express').Router();
  router.use(authMW);

  router.get('/', listTasks);
  router.get('/summary', getSummary);
  router.get('/streak', getStreak);
  router.get('/nudges', getNudges);
  router.post('/suggest-steps', suggestSteps);
  router.post('/suggest-duration', suggestDuration);
  router.post('/', createTask);

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