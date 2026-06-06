/**
 * AI Task Suggestions — value-driven, ADHD-friendly task suggestions
 *
 * GET    /api/ai-suggestions         — fetch current suggestions (auto-generates if none today)
 * POST   /api/ai-suggestions/refresh — force-refresh suggestions (daily cap for free tier)
 * POST   /api/ai-suggestions/:id/accept  — accept → creates real task
 * POST   /api/ai-suggestions/:id/dismiss — dismiss (never show similar again signal)
 *
 * Tier gating:
 *   Free: 3 suggestions per day total
 *   Pro:  Unlimited refreshes + spending-informed suggestions
 */

const express = require('express');
const { complete } = require('../lib/claude-client');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserTimezone, getUserLocalDate, getUserLocalHour } = require('../lib/timezone');

const FREE_DAILY_LIMIT = 3;
const BATCH_SIZE_PRO = 5;
const BATCH_SIZE_FREE = 3;
const LLM_TIMEOUT_MS = 8000;

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  async function getDailyGeneratedCount(userId, tz) {
    // WHY tz + getUserLocalDate: CURRENT_DATE is UTC on Neon — we need the user's
    // local day boundaries for the daily cap to work correctly in every timezone.
    const localToday = getUserLocalDate(tz);
    const result = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM ai_task_suggestions
       WHERE user_id = $1
         AND generated_at::date >= $2::date
         AND generated_at::date < $2::date + INTERVAL '1 day'`,
      [userId, localToday]
    );
    return parseInt(result.rows[0].cnt) || 0;
  }

  async function getUserValues(userId) {
    const result = await pool.query(
      `SELECT id, value_name, icon, weekly_hours_target, weekly_spend_target
       FROM user_values
       WHERE user_id = $1
       ORDER BY rank ASC
       LIMIT 5`,
      [userId]
    );
    return result.rows;
  }

  async function getRecentTasks(userId) {
    const result = await pool.query(
      `SELECT title, is_completed, completed_at
       FROM tasks
       WHERE user_id = $1
         AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC
       LIMIT 15`,
      [userId]
    );
    return result.rows;
  }

  // Pro-only: recent spending patterns to enrich suggestions
  async function getSpendingContext(userId) {
    try {
      const result = await pool.query(
        `SELECT category, SUM(amount) as total, COUNT(*) as count
         FROM expenses
         WHERE user_id = $1
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY category
         ORDER BY total DESC
         LIMIT 5`,
        [userId]
      );
      return result.rows;
    } catch (_e) {
      return [];
    }
  }

  async function getDismissedTitles(userId) {
    const result = await pool.query(
      `SELECT suggestion_title
       FROM ai_task_suggestions
       WHERE user_id = $1
         AND status = 'dismissed'
         AND dismissed_at >= NOW() - INTERVAL '7 days'
       ORDER BY dismissed_at DESC
       LIMIT 20`,
      [userId]
    );
    return result.rows.map(r => r.suggestion_title);
  }

  function getTimeContext(tz) {
    // WHY getUserLocalHour: time-of-day greeting (morning/afternoon/evening) must match
    // the user's actual local time, not the server's UTC clock.
    const hour = getUserLocalHour(tz);
    const now = new Date();
    const day = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
    let timeOfDay = 'morning';
    if (hour >= 12 && hour < 17) timeOfDay = 'afternoon';
    else if (hour >= 17 && hour < 21) timeOfDay = 'evening';
    else if (hour >= 21 || hour < 5) timeOfDay = 'night';
    return { day, timeOfDay };
  }

  async function generateSuggestions(userId, isPro, batchSize, tz) {
    const [values, recentTasks, dismissedTitles, spendingCtx] = await Promise.all([
      getUserValues(userId),
      getRecentTasks(userId),
      getDismissedTitles(userId),
      isPro ? getSpendingContext(userId) : Promise.resolve([])
    ]);

    if (values.length === 0) {
      return { suggestions: [], reason: 'no_values' };
    }

    const { day, timeOfDay } = getTimeContext(tz);

    // Build the prompt
    const valuesList = values.map(v => `${v.icon || '⭐'} ${v.value_name}`).join(', ');
    const completedTasks = recentTasks.filter(t => t.is_completed).slice(0, 5).map(t => t.title).join(', ') || 'none';
    const activeTasks = recentTasks.filter(t => !t.is_completed).slice(0, 5).map(t => t.title).join(', ') || 'none';

    let spendingNote = '';
    if (isPro && spendingCtx.length > 0) {
      const topSpend = spendingCtx.map(s => `${s.category}: $${parseFloat(s.total).toFixed(0)}`).join(', ');
      spendingNote = `\nRecent 30-day spending: ${topSpend}`;
    }

    let avoidNote = '';
    if (dismissedTitles.length > 0) {
      avoidNote = `\nDo NOT suggest anything similar to these recently dismissed suggestions: ${dismissedTitles.slice(0, 5).join('; ')}`;
    }

    const systemPrompt = `You are an ADHD-friendly personal task coach. Generate specific, bite-sized, actionable task suggestions based on a person's stated values.

Rules for each suggestion:
- Must be completable in under 60 minutes
- Start with an action verb
- Be concrete and specific — NOT generic advice
- 5-15 words maximum for the title
- Target low "activation energy" (easy to start RIGHT NOW)
- For values like Health: "Drink a full glass of water now" NOT "Be healthier"
- For values like Family: "Text [name] — it's been a while" NOT "Spend time with family"
- For values like Finance/Money: reference specific actions like reviewing a bill, canceling a subscription, setting a savings goal

Return ONLY a valid JSON array of ${batchSize} objects with this exact schema:
[{"title": "Action-oriented task title here", "value_name": "Health", "steps": []}, ...]

Steps should only be included for multi-step tasks. Each step is a short string (under 10 words).`;

    const userPrompt = `User's values: ${valuesList}
Current time: ${day} ${timeOfDay}
Recently completed tasks: ${completedTasks}
Active tasks (don't duplicate these): ${activeTasks}${spendingNote}${avoidNote}

Generate ${batchSize} personalized, highly specific task suggestions tied to their values. Make them feel like a thoughtful friend who knows them well.`;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('llm_timeout')), LLM_TIMEOUT_MS)
    );

    const completionPromise = complete({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 600,
    });

    let raw;
    try {
      raw = await Promise.race([completionPromise, timeoutPromise]);
    } catch (raceErr) {
      if (raceErr.message === 'llm_timeout') {
        return { suggestions: [], reason: 'timeout' };
      }
      throw raceErr;
    }
    let parsed = [];

    try {
      const cleaned = raw.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        parsed = arr.slice(0, batchSize).filter(s => s && typeof s.title === 'string' && s.title.trim());
      }
    } catch (_parseErr) {
      // Fallback: try to extract JSON array from response
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          const arr = JSON.parse(match[0]);
          if (Array.isArray(arr)) {
            parsed = arr.slice(0, batchSize).filter(s => s && typeof s.title === 'string' && s.title.trim());
          }
        } catch (_e2) { /* give up */ }
      }
    }

    if (parsed.length === 0) {
      return { suggestions: [], reason: 'parse_error' };
    }

    // Build value_id map for DB storage
    const valueMap = {};
    values.forEach(v => { valueMap[v.value_name] = v.id; });

    // Persist to DB
    const inserted = [];
    for (const s of parsed) {
      const steps = Array.isArray(s.steps) ? s.steps.filter(st => typeof st === 'string' && st.trim()) : [];
      const valueId = valueMap[s.value_name] || null;
      const insertResult = await pool.query(
        `INSERT INTO ai_task_suggestions
           (user_id, value_id, suggestion_title, suggestion_steps, status, generated_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())
         RETURNING *`,
        [userId, valueId, s.title.trim(), JSON.stringify(steps)]
      );
      inserted.push(insertResult.rows[0]);
    }

    // Attach value names from our values list for display
    const valueLookup = {};
    values.forEach(v => { valueLookup[v.id] = v; });

    return {
      suggestions: inserted.map(row => ({
        ...row,
        value_name: row.value_id ? (valueLookup[row.value_id]?.value_name || null) : (parsed.find(p => p.title === row.suggestion_title)?.value_name || null),
        value_icon: row.value_id ? (valueLookup[row.value_id]?.icon || null) : null,
        suggestion_steps: Array.isArray(row.suggestion_steps) ? row.suggestion_steps : (JSON.parse(row.suggestion_steps || '[]'))
      }))
    };
  }

  // ─────────────────────────────────────────────────────────────
  // GET / — fetch current pending suggestions, auto-generate if needed
  // ─────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    const userId = req.user.id;
    try {
      const tz = await fetchUserTimezone(pool, userId);
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      const dailyCount = await getDailyGeneratedCount(userId, tz);
      const dailyLimit = isPro ? null : FREE_DAILY_LIMIT;
      const atCap = !isPro && dailyCount >= FREE_DAILY_LIMIT;

      // Fetch current pending suggestions (generated today)
      const pending = await pool.query(
        `SELECT s.*, uv.value_name, uv.icon as value_icon, uv.color as value_color
         FROM ai_task_suggestions s
         LEFT JOIN user_values uv ON uv.id = s.value_id
         WHERE s.user_id = $1
           AND s.status = 'pending'
           AND s.generated_at >= CURRENT_DATE
         ORDER BY s.generated_at DESC`,
        [userId]
      );

      if (pending.rows.length > 0) {
        return res.json({
          success: true,
          suggestions: pending.rows.map(r => ({
            id: r.id,
            suggestion_title: r.suggestion_title,
            suggestion_steps: Array.isArray(r.suggestion_steps) ? r.suggestion_steps : (JSON.parse(r.suggestion_steps || '[]')),
            status: r.status,
            generated_at: r.generated_at,
            value_name: r.value_name,
            value_icon: r.value_icon,
            value_color: r.value_color
          })),
          is_pro: isPro,
          daily_used: dailyCount,
          daily_limit: dailyLimit,
          at_cap: atCap
        });
      }

      // No pending suggestions today — check values
      const values = await getUserValues(userId);
      if (values.length === 0) {
        return res.json({
          success: true,
          suggestions: [],
          is_pro: isPro,
          daily_used: dailyCount,
          daily_limit: dailyLimit,
          at_cap: false,
          reason: 'no_values'
        });
      }

      // At cap — don't generate
      if (atCap) {
        return res.json({
          success: true,
          suggestions: [],
          is_pro: false,
          daily_used: dailyCount,
          daily_limit: FREE_DAILY_LIMIT,
          at_cap: true,
          reason: 'daily_cap'
        });
      }

      // Generate new batch
      const batchSize = isPro ? BATCH_SIZE_PRO : Math.min(BATCH_SIZE_FREE, FREE_DAILY_LIMIT - dailyCount);
      const result = await generateSuggestions(userId, isPro, batchSize, tz);

      const newDailyCount = await getDailyGeneratedCount(userId, tz);

      return res.json({
        success: true,
        suggestions: result.suggestions,
        is_pro: isPro,
        daily_used: newDailyCount,
        daily_limit: dailyLimit,
        at_cap: !isPro && newDailyCount >= FREE_DAILY_LIMIT,
        reason: result.reason || null
      });
    } catch (err) {
      console.error('[AI Suggestions] GET error:', err.message);
      res.json({ success: true, suggestions: [], is_pro: false, daily_used: 0, daily_limit: FREE_DAILY_LIMIT, at_cap: false, reason: 'error' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /refresh — force-refresh suggestions
  // ─────────────────────────────────────────────────────────────
  router.post('/refresh', async (req, res) => {
    const userId = req.user.id;
    try {
      const tz = await fetchUserTimezone(pool, userId);
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      const dailyCount = await getDailyGeneratedCount(userId, tz);

      if (!isPro && dailyCount >= FREE_DAILY_LIMIT) {
        return res.status(402).json({
          success: false,
          at_cap: true,
          daily_used: dailyCount,
          daily_limit: FREE_DAILY_LIMIT,
          message: `You've used your ${FREE_DAILY_LIMIT} free suggestions for today. Upgrade to Pro for unlimited refreshes.`,
          upgrade_required: true
        });
      }

      // Dismiss all current pending suggestions to make room
      await pool.query(
        `UPDATE ai_task_suggestions
         SET status = 'dismissed', dismissed_at = NOW()
         WHERE user_id = $1 AND status = 'pending'`,
        [userId]
      );

      const values = await getUserValues(userId);
      if (values.length === 0) {
        return res.json({ success: true, suggestions: [], reason: 'no_values' });
      }

      const remaining = isPro ? BATCH_SIZE_PRO : Math.min(BATCH_SIZE_FREE, FREE_DAILY_LIMIT - dailyCount);
      const batchSize = Math.max(1, remaining);

      const result = await generateSuggestions(userId, isPro, batchSize, tz);
      const newDailyCount = await getDailyGeneratedCount(userId, tz);

      return res.json({
        success: true,
        suggestions: result.suggestions,
        is_pro: isPro,
        daily_used: newDailyCount,
        daily_limit: isPro ? null : FREE_DAILY_LIMIT,
        at_cap: !isPro && newDailyCount >= FREE_DAILY_LIMIT,
        reason: result.reason || null
      });
    } catch (err) {
      console.error('[AI Suggestions] refresh error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to refresh suggestions' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /:id/accept — accept suggestion → create a real task
  // ─────────────────────────────────────────────────────────────
  router.post('/:id/accept', async (req, res) => {
    const userId = req.user.id;
    const suggestionId = parseInt(req.params.id);

    try {
      // Fetch the suggestion
      const sRes = await pool.query(
        'SELECT * FROM ai_task_suggestions WHERE id = $1 AND user_id = $2',
        [suggestionId, userId]
      );
      if (sRes.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Suggestion not found' });
      }
      const suggestion = sRes.rows[0];

      if (suggestion.status !== 'pending') {
        return res.status(400).json({ success: false, message: 'Suggestion already actioned' });
      }

      // Check free task limit
      const isPro = await checkProStatus(pool, userId).catch(() => false);
      if (!isPro) {
        const activeCount = await pool.query(
          'SELECT COUNT(*) as count FROM tasks WHERE is_completed = false AND user_id = $1',
          [userId]
        );
        if (parseInt(activeCount.rows[0].count) >= 10) {
          return res.status(402).json({
            success: false,
            message: 'You have 10 active tasks — the free plan cap. Finish a few, or open it up with Pro.',
            code: 'TASK_LIMIT_REACHED',
            upgrade_required: true
          });
        }
      }

      const steps = Array.isArray(suggestion.suggestion_steps)
        ? suggestion.suggestion_steps
        : (JSON.parse(suggestion.suggestion_steps || '[]'));

      const client = await pool.connect();
      let taskId;
      try {
        await client.query('BEGIN');

        const taskResult = await client.query(
          `INSERT INTO tasks (title, user_id, value_id, source, created_at)
           VALUES ($1, $2, $3, 'ai_suggestion', NOW())
           RETURNING *`,
          [suggestion.suggestion_title, userId, suggestion.value_id]
        );
        taskId = taskResult.rows[0].id;

        // Insert steps if present
        for (let i = 0; i < steps.length; i++) {
          if (steps[i] && steps[i].trim()) {
            await client.query(
              'INSERT INTO task_steps (task_id, title, sort_order) VALUES ($1, $2, $3)',
              [taskId, steps[i].trim(), i]
            );
          }
        }

        // Mark suggestion as accepted
        await client.query(
          `UPDATE ai_task_suggestions
           SET status = 'accepted', accepted_at = NOW()
           WHERE id = $1`,
          [suggestionId]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Fetch the created task with steps
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
        WHERE t.id = $1
        GROUP BY t.id
      `, [taskId]);

      res.json({ success: true, task: fullTask.rows[0] });
    } catch (err) {
      console.error('[AI Suggestions] accept error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to accept suggestion' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /:id/dismiss — dismiss suggestion (signal preference)
  // ─────────────────────────────────────────────────────────────
  router.post('/:id/dismiss', async (req, res) => {
    const userId = req.user.id;
    const suggestionId = parseInt(req.params.id);

    try {
      const result = await pool.query(
        `UPDATE ai_task_suggestions
         SET status = 'dismissed', dismissed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING id`,
        [suggestionId, userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ success: false, message: 'Suggestion not found or already actioned' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[AI Suggestions] dismiss error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to dismiss suggestion' });
    }
  });

  console.log('[AI Suggestions] Routes registered');
  return router;
};
