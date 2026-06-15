/**
 * Values Alignment Nudges
 *
 * GET  /api/nudges         — returns active alignment nudges (Pro only)
 * POST /api/nudges/dismiss — dismiss a nudge (7-day cooldown)
 *
 * Three nudge types:
 *   spending_alignment — spending doesn't match value priorities
 *   time_alignment     — insufficient time blocked for top values
 *   task_alignment     — tasks skewed toward one value / top value has nothing
 *
 * ─── Voice Philosophy (McLuhan + de Botton) ───────────────────────────────
 * McLuhan: the nudge itself is the intervention. How we say it shapes how the
 * user relates to their own habits. Keep the medium cool — leave room for
 * the user's own interpretation. Don't over-explain, don't over-notify.
 *
 * De Botton: managing money and time is the architecture of a well-lived life.
 * Treat these observations with dignity. No guilt. No shame. Curiosity only.
 * "Interesting pattern this week" not "You exceeded your budget!"
 * The nudge should feel like a thoughtful friend noticing something, not
 * a productivity drill sergeant marking failures.
 * ──────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {
  router.use(authenticateToken);

  // GET alignment nudges
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;

      // Check Pro status (Stripe subscription OR admin override)
      let isPro = false;
      try {
        isPro = await checkProStatus(pool, userId);
      } catch (e) {
        console.error('[alignment-nudges] Pro check failed:', e.message);
        // Fail open: treat as free if check fails (nudges are informational)
      }

      if (!isPro) {
        return res.json({ success: true, nudges: [], teaser: true });
      }

      // Fetch user's values (ordered by rank)
      const valuesResult = await pool.query(
        'SELECT * FROM user_values WHERE user_id = $1 ORDER BY rank ASC',
        [userId]
      );
      const values = valuesResult.rows;

      if (values.length === 0) {
        return res.json({ success: true, nudges: [], teaser: false, setup_needed: true });
      }

      const top3 = values.slice(0, 3);

      // Check dismissed nudges (7-day window)
      const dismissedResult = await pool.query(
        `SELECT nudge_type, pattern_key FROM nudge_dismissals
         WHERE user_id = $1 AND dismissed_at > NOW() - INTERVAL '7 days'`,
        [userId]
      );
      const dismissed = new Set(dismissedResult.rows.map(r => `${r.nudge_type}:${r.pattern_key}`));

      // WHY: CURRENT_DATE is UTC on Neon — use user's local date for daily nudge cap
      const localDate = await fetchUserLocalDate(pool, userId);

      const todayDismissedResult = await pool.query(
        `SELECT COUNT(*) as count FROM nudge_dismissals
         WHERE user_id = $1 AND dismissed_at::date = $2::date`,
        [userId, localDate]
      );
      const shownToday = parseInt(todayDismissedResult.rows[0].count) || 0;
      const quota = Math.max(0, 3 - shownToday);

      if (quota === 0) {
        return res.json({ success: true, nudges: [], teaser: false });
      }

      const nudges = [];
      const weekStart = getWeekStart(localDate);
      const weekLabel = weekStart.toISOString().slice(0, 10);
      // WHY: use localDate-derived day-of-week, not UTC's
      const localDateObj = new Date(localDate + 'T12:00:00Z');
      const dayOfWeek = localDateObj.getUTCDay(); // 0=Sun

      // ================================================================
      // 1. TASK ALIGNMENT
      // ================================================================
      try {
        const tasksResult = await pool.query(
          'SELECT id, title, value_id FROM tasks WHERE user_id = $1 AND is_completed = false',
          [userId]
        );
        const activeTasks = tasksResult.rows;

        if (activeTasks.length >= 3) {
          const countByValue = {};
          activeTasks.forEach(t => {
            if (t.value_id) countByValue[t.value_id] = (countByValue[t.value_id] || 0) + 1;
          });

          // Nudge: >70% of active tasks belong to a single value
          for (const [vid, count] of Object.entries(countByValue)) {
            if (count / activeTasks.length > 0.7) {
              const dominant = values.find(v => v.id === parseInt(vid));
              if (dominant) {
                const patternKey = `dominated-by-${vid}`;
                if (!dismissed.has(`task_alignment:${patternKey}`)) {
                  const otherTop = top3.find(v => v.id !== parseInt(vid));
                  nudges.push({
                    type: 'task_alignment',
                    pattern_key: patternKey,
                    // De Botton: observe without judgment. McLuhan: cool media — don't over-explain.
                    message: `${count} of your ${activeTasks.length} tasks are tied to ${dominant.name}.`,
                    sub_message: `Your other values are quiet right now — worth a moment?`,
                    action_type: 'add_task',
                    action_label: otherTop ? `Add a ${otherTop.name} task` : 'Add a task',
                    action_value_id: otherTop ? otherTop.id : null,
                    action_value_name: otherTop ? otherTop.name : null,
                    value_name: dominant.name,
                    value_color: dominant.color
                  });
                }
              }
            }
          }

          // Nudge: a top-3 value has 0 active tasks
          for (const v of top3) {
            const count = countByValue[v.id] || 0;
            if (count === 0) {
              const patternKey = `zero-tasks-${v.id}`;
              if (!dismissed.has(`task_alignment:${patternKey}`)) {
                nudges.push({
                  type: 'task_alignment',
                  pattern_key: patternKey,
                  // De Botton: dignity, not pressure. Frame as possibility, not deficit.
                  message: `${v.value_name} is your #${v.rank} value — nothing on the list for it yet.`,
                  sub_message: `Worth adding something, even small.`,
                  action_type: 'add_task',
                  action_label: `Add a ${v.value_name} task`,
                  action_value_id: v.id,
                  action_value_name: v.value_name,
                  value_name: v.value_name,
                  value_color: v.color
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn('[AlignmentNudges] Task analysis error:', e.message);
      }

      // ================================================================
      // 2. SPENDING ALIGNMENT
      // ================================================================
      const valuesWithCategory = values.filter(v => v.category_id);
      if (valuesWithCategory.length > 0) {
        try {
          // Manual expenses this week
          const expResult = await pool.query(
            `SELECT category_id, SUM(amount) as total
             FROM expenses
             WHERE user_id = $1 AND created_at >= $2
             GROUP BY category_id`,
            [userId, weekStart.toISOString()]
          );

          // Plaid transactions this week
          let plaidRows = [];
          try {
            const plaidResult = await pool.query(
              `SELECT category_id, SUM(amount) as total
               FROM plaid_transactions
               WHERE user_id = $1 AND date >= $2 AND is_dismissed = false
               GROUP BY category_id`,
              [userId, weekStart.toISOString().slice(0, 10)]
            );
            plaidRows = plaidResult.rows;
          } catch { /* Plaid might not be set up */ }

          // Merge spend
          const spendByCat = {};
          [...expResult.rows, ...plaidRows].forEach(row => {
            if (row.category_id) {
              spendByCat[row.category_id] = (spendByCat[row.category_id] || 0) + parseFloat(row.total || 0);
            }
          });

          // Top-3 value spending vs target
          for (const v of top3) {
            if (!v.category_id || parseFloat(v.weekly_spend_target) <= 0) continue;
            const spent = spendByCat[v.category_id] || 0;
            if (spent > parseFloat(v.weekly_spend_target)) {
              const over = (spent - parseFloat(v.weekly_spend_target)).toFixed(0);
              const patternKey = `overspent-${v.id}-${weekLabel}`;
              if (!dismissed.has(`spending_alignment:${patternKey}`)) {
                nudges.push({
                  type: 'spending_alignment',
                  pattern_key: patternKey,
                  // De Botton: overspending language should be exploratory, not punitive.
                  // Curiosity, not judgment. "Interesting pattern" not "You exceeded your budget!"
                  message: `You've spent $${spent.toFixed(0)} on ${v.value_name} this week — $${over} beyond your $${parseFloat(v.weekly_spend_target).toFixed(0)} intention.`,
                  sub_message: `Curious what was behind that?`,
                  action_type: 'dismiss',
                  action_label: 'Got it',
                  value_name: v.value_name,
                  value_color: v.color
                });
              }
            }
          }

          // Non-top-3 value spending 2x a top-3 value
          const nonTop3 = values.slice(3);
          for (const nonTop of nonTop3) {
            if (!nonTop.category_id) continue;
            const nonTopSpend = spendByCat[nonTop.category_id] || 0;
            if (nonTopSpend < 20) continue;
            for (const topVal of top3) {
              if (!topVal.category_id) continue;
              const topSpend = spendByCat[topVal.category_id] || 0;
              if (nonTopSpend >= topSpend * 2 && nonTopSpend >= 20) {
                const patternKey = `imbalance-${nonTop.id}-vs-${topVal.id}-${weekLabel}`;
                if (!dismissed.has(`spending_alignment:${patternKey}`)) {
                  nudges.push({
                    type: 'spending_alignment',
                    pattern_key: patternKey,
                    // De Botton: frame as a gentle observation, not a verdict.
                    message: `$${nonTopSpend.toFixed(0)} on ${nonTop.name} vs $${topSpend.toFixed(0)} on ${topVal.name} (your #${topVal.rank} priority) this week.`,
                    sub_message: `Interesting pattern — does that feel right?`,
                    action_type: 'dismiss',
                    action_label: 'Got it',
                    value_name: topVal.name,
                    value_color: topVal.color
                  });
                }
              }
            }
          }
        } catch (e) {
          console.warn('[AlignmentNudges] Spending analysis error:', e.message);
        }
      }

      // ================================================================
      // 3. TIME ALIGNMENT
      // ================================================================
      try {
        const blocksResult = await pool.query(
          `SELECT value_id,
             SUM(
               EXTRACT(EPOCH FROM (end_time - start_time)) / 3600
             ) as hours
           FROM time_blocks
           WHERE user_id = $1 AND block_date >= $2
           GROUP BY value_id`,
          [userId, weekStart.toISOString().slice(0, 10)]
        );

        const hoursPerValue = {};
        blocksResult.rows.forEach(r => {
          if (r.value_id) hoursPerValue[r.value_id] = parseFloat(r.hours || 0);
        });

        for (const v of top3) {
          if (parseFloat(v.weekly_hours_target) <= 0) continue;
          const hours = hoursPerValue[v.id] || 0;
          const target = parseFloat(v.weekly_hours_target);
          const pct = hours / target;

          if (dayOfWeek >= 4 && hours === 0) {
            // Thursday+: zero hours for a top value
            const patternKey = `zero-hours-${v.id}-${weekLabel}`;
            if (!dismissed.has(`time_alignment:${patternKey}`)) {
              const daysLeft = 7 - dayOfWeek;
              nudges.push({
                type: 'time_alignment',
                pattern_key: patternKey,
                // De Botton: curiosity not judgment. Frame as opportunity, not failure.
                message: `${v.value_name} is your #${v.rank} value — nothing blocked for it yet this week.`,
                sub_message: `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left. Still time to protect some.`,
                action_type: 'add_time_block',
                action_label: `Block time for ${v.value_name}`,
                action_value_id: v.id,
                action_value_name: v.value_name,
                value_name: v.value_name,
                value_color: v.color
              });
            }
          } else if (dayOfWeek >= 3 && pct < 0.5) {
            // Wednesday+: under 50% of target
            const patternKey = `low-hours-${v.id}-${weekLabel}`;
            if (!dismissed.has(`time_alignment:${patternKey}`)) {
              nudges.push({
                type: 'time_alignment',
                pattern_key: patternKey,
                // McLuhan: cool media — state the observation simply, let the user decide.
                message: `${hours.toFixed(1)} of ${target}h blocked for ${v.value_name} so far this week.`,
                sub_message: `Past midweek — want to carve out a bit more?`,
                action_type: 'add_time_block',
                action_label: `Block time for ${v.value_name}`,
                action_value_id: v.id,
                action_value_name: v.value_name,
                value_name: v.value_name,
                value_color: v.color
              });
            }
          }
        }
      } catch (e) {
        console.warn('[AlignmentNudges] Time analysis error:', e.message);
      }

      // Deduplicate and cap to daily quota
      const seen = new Set();
      const finalNudges = nudges
        .filter(n => {
          const key = `${n.type}:${n.pattern_key}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, quota);

      res.json({ success: true, nudges: finalNudges, teaser: false });

    } catch (err) {
      console.error('[AlignmentNudges] Error:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch alignment nudges' });
    }
  });

  // POST dismiss a nudge
  router.post('/dismiss', async (req, res) => {
    try {
      const { nudge_type, pattern_key } = req.body;
      if (!nudge_type || !pattern_key) {
        return res.status(400).json({ success: false, message: 'nudge_type and pattern_key are required' });
      }

      await pool.query(
        `INSERT INTO nudge_dismissals (user_id, nudge_type, pattern_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, nudge_type, pattern_key) DO UPDATE SET dismissed_at = NOW()`,
        [req.user.id, nudge_type, pattern_key]
      );

      res.json({ success: true });
    } catch (err) {
      console.error('[AlignmentNudges] Error dismissing:', err);
      res.status(500).json({ success: false, message: 'Failed to dismiss nudge' });
    }
  });

  // --- Helpers ---
  /** @param {string} [localDate] — YYYY-MM-DD in user's timezone */
  function getWeekStart(localDate) {
    const now = localDate ? new Date(localDate + 'T12:00:00Z') : new Date();
    const day = now.getUTCDay();
    const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(now);
    monday.setUTCDate(diff);
    monday.setUTCHours(0, 0, 0, 0);
    return monday;
  }

  return router;
};
