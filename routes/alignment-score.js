/**
 * Values Alignment Score (Free Tier)
 *
 * GET  /api/alignment-score           — daily alignment score (60% task + 40% spending)
 * GET  /api/alignment-score/report    — latest (or by week) weekly report
 * POST /api/alignment-score/report/generate — generate/refresh report for current week
 * POST /api/alignment-score/nudge-interaction — track inline nudge event
 *
 * Formula v1:
 *   task_score    = (tasks with a value_id) / (total active + completed-this-week tasks) * 100
 *   spending_score = (expenses whose category maps to any of user's values) / total expenses this week * 100
 *   overall = task_score * 0.6 + spending_score * 0.4
 *
 * Free tier: all endpoints are available to authenticated users regardless of Pro status.
 *
 * Analytics events emitted (fire-and-forget):
 *   values_score_viewed, weekly_report_viewed, nudge_shown, nudge_dismissed, nudge_value_tagged
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { backfillUser } = require('../lib/auto-tagger');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ───────────────────────────────────────────────────────────────────
  // Helper: get Monday of the current week
  // WHY localDate param: new Date() is UTC — week boundary must match user's calendar
  // ───────────────────────────────────────────────────────────────────
  function getWeekStart(refDate) {
    const d = refDate ? new Date(refDate + 'T12:00:00Z') : new Date();
    const day = d.getUTCDay(); // 0=Sun
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setUTCDate(diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday;
  }

  // ───────────────────────────────────────────────────────────────────
  // Helper: compute alignment scores for a user over a date range
  // Returns { task_score, spending_score, overall_score, breakdown }
  // ───────────────────────────────────────────────────────────────────
  async function computeScores(userId, weekStart) {
    const weekStartStr = weekStart.toISOString();
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = weekEnd.toISOString();

    // Get user's values
    const valuesResult = await pool.query(
      'SELECT id, value_name, icon, color, rank FROM user_values WHERE user_id = $1 ORDER BY rank ASC',
      [userId]
    );
    const values = valuesResult.rows;

    if (values.length === 0) {
      return { task_score: 0, spending_score: 0, overall_score: 0, breakdown: [], has_values: false };
    }

    const valueIds = values.map(v => v.id);

    // ── TASK SCORE ──────────────────────────────────────────────────
    // Count tasks: active (not completed) OR completed this week
    let taskTotal = 0;
    let taskAligned = 0;
    const taskBreakdown = {}; // value_id → task count

    try {
      const tasksResult = await pool.query(
        `SELECT id, value_id, is_completed, created_at
         FROM tasks
         WHERE user_id = $1
           AND (
             is_completed = false
             OR (is_completed = true AND updated_at >= $2 AND updated_at < $3)
           )`,
        [userId, weekStartStr, weekEndStr]
      );

      taskTotal = tasksResult.rows.length;
      tasksResult.rows.forEach(t => {
        if (t.value_id) {
          taskAligned++;
          taskBreakdown[t.value_id] = (taskBreakdown[t.value_id] || 0) + 1;
        }
      });
    } catch {
      // table may not exist yet — treat as 0
    }

    const task_score = taskTotal > 0 ? Math.round((taskAligned / taskTotal) * 100) : 0;

    // ── SPENDING SCORE ───────────────────────────────────────────────
    // Get category→value mappings for this user
    // A mapping exists if: value_category_mappings has an entry for a value owned by this user
    let spendingTotal = 0;
    let spendingAligned = 0;
    const spendBreakdown = {}; // value_id → spend amount

    try {
      // Get expenses this week — use value_id if set, otherwise fall back to category mapping
      const expResult = await pool.query(
        `SELECT e.id, e.amount, e.value_id, c.name as category_name
         FROM expenses e
         LEFT JOIN categories c ON c.id = e.category_id
         WHERE e.user_id = $1 AND e.expense_date >= $2::date AND e.expense_date < $3::date`,
        [userId, weekStartStr, weekEndStr]
      );

      // Also get category mappings for fallback
      const mappingsResult = await pool.query(
        `SELECT vcm.value_id, vcm.category_name
         FROM value_category_mappings vcm
         WHERE vcm.value_id = ANY($1)
           AND vcm.category_type = 'spending'`,
        [valueIds]
      );
      const catToValue = {};
      mappingsResult.rows.forEach(m => {
        catToValue[m.category_name.toLowerCase()] = m.value_id;
      });

      spendingTotal = expResult.rows.length;
      expResult.rows.forEach(e => {
        // Prefer direct value_id on the expense, fallback to category mapping
        let vId = null;
        if (e.value_id && valueIds.includes(e.value_id)) {
          vId = e.value_id;
        } else if (e.category_name) {
          vId = catToValue[(e.category_name || '').toLowerCase()] || null;
        }
        if (vId) {
          spendingAligned++;
          spendBreakdown[vId] = (spendBreakdown[vId] || 0) + parseFloat(e.amount || 0);
        }
      });
    } catch {
      // expenses table may not exist — treat as 0
    }

    const spending_score = spendingTotal > 0
      ? Math.round((spendingAligned / spendingTotal) * 100)
      : 0;

    // ── OVERALL ─────────────────────────────────────────────────────
    const overall_score = Math.round(task_score * 0.6 + spending_score * 0.4);

    // ── PER-VALUE BREAKDOWN ──────────────────────────────────────────
    const breakdown = values.map(v => ({
      value_id: v.id,
      value_name: v.value_name,
      icon: v.icon || '⭐',
      color: v.color || '#F26B3A',
      rank: v.rank,
      task_count: taskBreakdown[v.id] || 0,
      spend_amount: spendBreakdown[v.id] || 0
    }));

    return {
      task_score,
      spending_score,
      overall_score,
      breakdown,
      has_values: true,
      task_total: taskTotal,
      task_aligned: taskAligned,
      spending_total: spendingTotal,
      spending_aligned: spendingAligned
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // GET /api/alignment-score — daily score (Free)
  // ───────────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);
      const weekStart = getWeekStart(localDate);
      const scores = await computeScores(userId, weekStart);

      // Fire analytics event (fire-and-forget)
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, 'values_score_viewed', $3::jsonb, NOW())`,
        ['user-' + userId, userId, JSON.stringify({ score: scores.overall_score })]
      ).catch(() => {});

      res.json({ success: true, ...scores, week_start: weekStart.toISOString().slice(0, 10) });
    } catch (err) {
      console.error('[AlignmentScore] Error computing score:', err);
      res.status(500).json({ success: false, message: 'Failed to compute alignment score' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // GET /api/alignment-score/report — latest or specific week report
  // ?week=2026-04-21 (optional, defaults to most recent)
  // ───────────────────────────────────────────────────────────────────
  router.get('/report', async (req, res) => {
    try {
      const userId = req.user.id;

      let report;
      if (req.query.week) {
        const result = await pool.query(
          'SELECT * FROM user_weekly_reports WHERE user_id = $1 AND week_start = $2',
          [userId, req.query.week]
        );
        report = result.rows[0] || null;
      } else {
        const result = await pool.query(
          'SELECT * FROM user_weekly_reports WHERE user_id = $1 ORDER BY week_start DESC LIMIT 1',
          [userId]
        );
        report = result.rows[0] || null;
      }

      if (!report) {
        // No stored report — compute on the fly for current week
        const tz = await fetchUserTimezone(pool, userId);
        const weekStart = getWeekStart(getUserLocalDate(tz));
        const scores = await computeScores(userId, weekStart);
        return res.json({
          success: true,
          report: null,
          live_scores: scores,
          week_start: weekStart.toISOString().slice(0, 10)
        });
      }

      // Fire analytics event
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, 'weekly_report_viewed', $3::jsonb, NOW())`,
        ['user-' + userId, userId, JSON.stringify({ week_start: report.week_start })]
      ).catch(() => {});

      res.json({ success: true, report });
    } catch (err) {
      console.error('[AlignmentScore] Error fetching report:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch report' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /api/alignment-score/report/generate — generate/refresh report
  // Called by the frontend or by the weekly scheduler
  // ───────────────────────────────────────────────────────────────────
  router.post('/report/generate', async (req, res) => {
    try {
      const userId = req.user.id;
      const { week_start } = req.body; // optional ISO date string

      let weekStart;
      if (week_start) {
        weekStart = getWeekStart(week_start);
      } else {
        const tz = await fetchUserTimezone(pool, userId);
        weekStart = getWeekStart(getUserLocalDate(tz));
      }
      const weekStartDate = weekStart.toISOString().slice(0, 10);

      const scores = await computeScores(userId, weekStart);

      // Get previous week for trend
      const prevWeekStart = new Date(weekStart);
      prevWeekStart.setDate(prevWeekStart.getDate() - 7);
      const prevResult = await pool.query(
        'SELECT overall_score FROM user_weekly_reports WHERE user_id = $1 AND week_start = $2',
        [userId, prevWeekStart.toISOString().slice(0, 10)]
      );
      const prevScore = prevResult.rows[0]?.overall_score ?? null;
      const trend = prevScore !== null
        ? (scores.overall_score > prevScore ? 'up' : scores.overall_score < prevScore ? 'down' : 'flat')
        : null;

      // Find best and least aligned values
      const sortedByTasks = [...scores.breakdown].sort((a, b) => b.task_count - a.task_count);
      const bestValue = sortedByTasks[0] || null;
      const leastValue = sortedByTasks[sortedByTasks.length - 1] || null;

      // Actionable suggestion: find first value with 0 tasks
      const zeroTaskValue = scores.breakdown.find(v => v.task_count === 0);
      const suggestion = zeroTaskValue
        ? `You value ${zeroTaskValue.value_name} but completed 0 tasks for it this week — try adding one?`
        : null;

      const breakdown_json = {
        per_value: scores.breakdown,
        prev_score: prevScore,
        trend,
        best_value: bestValue ? { name: bestValue.value_name, task_count: bestValue.task_count } : null,
        least_value: leastValue ? { name: leastValue.value_name, task_count: leastValue.task_count } : null,
        suggestion,
        task_total: scores.task_total,
        task_aligned: scores.task_aligned,
        spending_total: scores.spending_total,
        spending_aligned: scores.spending_aligned
      };

      // Upsert the report
      const upsertResult = await pool.query(
        `INSERT INTO user_weekly_reports
           (user_id, week_start, overall_score, task_score, spending_score, breakdown_json, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, week_start)
         DO UPDATE SET
           overall_score = EXCLUDED.overall_score,
           task_score = EXCLUDED.task_score,
           spending_score = EXCLUDED.spending_score,
           breakdown_json = EXCLUDED.breakdown_json,
           generated_at = NOW()
         RETURNING *`,
        [
          userId,
          weekStartDate,
          scores.overall_score,
          scores.task_score,
          scores.spending_score,
          JSON.stringify(breakdown_json)
        ]
      );

      res.json({ success: true, report: upsertResult.rows[0] });
    } catch (err) {
      console.error('[AlignmentScore] Error generating report:', err);
      res.status(500).json({ success: false, message: 'Failed to generate report' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /api/alignment-score/nudge-interaction — log inline nudge
  // Body: { context: 'task'|'expense', action: 'shown'|'dismissed'|'value_tagged', value_id? }
  // ───────────────────────────────────────────────────────────────────
  router.post('/nudge-interaction', async (req, res) => {
    try {
      const userId = req.user.id;
      const { context, action, value_id } = req.body;

      if (!['task', 'expense'].includes(context) || !['shown', 'dismissed', 'value_tagged'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Invalid context or action' });
      }

      await pool.query(
        `INSERT INTO nudge_interactions (user_id, nudge_context, action, value_id, occurred_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, context, action, value_id || null]
      );

      // Analytics event
      const eventName = `nudge_${action}`;
      pool.query(
        `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())`,
        ['user-' + userId, userId, eventName, JSON.stringify({ context, value_id: value_id || null })]
      ).catch(() => {});

      res.json({ success: true });
    } catch (err) {
      console.error('[AlignmentScore] Error logging nudge interaction:', err);
      res.status(500).json({ success: false, message: 'Failed to log interaction' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // GET /api/alignment-score/check-alignment — check if a task title
  // or expense description/category aligns with any user value.
  // Used by inline nudge on add-task / add-expense.
  // Query params: type=task|expense, title=..., category=...
  // Returns: { aligned: bool, matched_value?: { id, value_name } }
  // ───────────────────────────────────────────────────────────────────
  router.get('/check-alignment', async (req, res) => {
    try {
      const userId = req.user.id;
      const { type, title, category } = req.query;

      // Get user's values
      const valuesResult = await pool.query(
        'SELECT id, value_name FROM user_values WHERE user_id = $1 ORDER BY rank ASC',
        [userId]
      );
      const values = valuesResult.rows;

      if (values.length === 0) {
        // No values set — nudges don't fire
        return res.json({ success: true, has_values: false, aligned: true });
      }

      if (type === 'task') {
        // For tasks: check if title contains any value name (case-insensitive)
        const titleLower = (title || '').toLowerCase();
        const matched = values.find(v => titleLower.includes(v.value_name.toLowerCase()));
        return res.json({ success: true, has_values: true, aligned: !!matched, matched_value: matched || null });
      }

      if (type === 'expense') {
        // For expenses: check if category matches any value_category_mappings
        const valueIds = values.map(v => v.id);
        const catLower = (category || '').toLowerCase();

        const mappingResult = await pool.query(
          `SELECT vcm.value_id, uv.value_name
           FROM value_category_mappings vcm
           JOIN user_values uv ON uv.id = vcm.value_id
           WHERE vcm.value_id = ANY($1)
             AND vcm.category_type = 'spending'
             AND LOWER(vcm.category_name) = $2`,
          [valueIds, catLower]
        );

        const matched = mappingResult.rows[0] || null;
        return res.json({ success: true, has_values: true, aligned: !!matched, matched_value: matched });
      }

      res.json({ success: true, has_values: true, aligned: true });
    } catch (err) {
      console.error('[AlignmentScore] Error checking alignment:', err);
      // On error, don't block the user — return aligned=true to suppress nudge
      res.json({ success: true, aligned: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /api/alignment-score/backfill — run auto-tagger on all
  // untagged tasks and expenses for the current user
  // ───────────────────────────────────────────────────────────────────
  router.post('/backfill', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await backfillUser(pool, userId);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[AlignmentScore] Error backfilling:', err);
      res.status(500).json({ success: false, message: 'Failed to backfill' });
    }
  });

  return router;
};
