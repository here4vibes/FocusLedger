'use strict';
/**
 * routes/home-context.js — Single fan-in endpoint for home/dashboard page.
 *
 * Replaces 5 serial HTTP calls with 1 call + 7 parallel DB queries.
 * Eliminates duplicate queries: buddy_checkins, buddy_conversations, and
 * expenses were each queried 2–3 times across the old endpoints.
 *
 * GET /api/home-context?localHour=<0-23>
 *
 * Response shape mirrors the union of what home.html needed from:
 *   - GET /api/auth/me
 *   - GET /api/buddy-widget/context
 *   - GET /api/buddy-widget/notification-count
 *   - GET /api/momentum-score
 *   - GET /api/money/expenses/today
 */
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getUserLocalDate } = require('../lib/timezone');

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const localHour = parseInt(req.query.localHour || new Date().getHours(), 10);
      const isEveningTime = localHour >= 17 && localHour <= 22;

      // Step 1: user row — needed for name + timezone (drives date-sensitive queries)
      const userRow = await pool.query(
        `SELECT name, email, COALESCE(timezone, 'America/New_York') AS tz
         FROM users WHERE id = $1`,
        [userId]
      );
      const user = userRow.rows[0] || {};
      const tz = user.tz || 'America/New_York';
      const today = getUserLocalDate(tz);

      // Compute week start (Monday) for awareness score
      const d = new Date(today + 'T12:00:00Z');
      const dow = d.getUTCDay();
      const diff = d.getUTCDate() - dow + (dow === 0 ? -6 : 1);
      const weekStart = new Date(d);
      weekStart.setUTCDate(diff);
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      // Step 2: all data queries in parallel — zero duplicates
      const [
        incompleteRes,    // open task count (for stats chip + tasks card badge)
        completedRes,     // tasks done today (momentum: traction)
        rhythmRes,        // routines done today (momentum: rhythm)
        checkinsRes,      // checkin types today (morning/evening + momentum: connection)
        buddyMsgRes,      // new buddy message last 5 min
        missedRouteRes,   // any routine missed so far today
        expensesRes,      // all expense stats in one scan (untriaged + today spend + reviewed)
      ] = await Promise.all([
        // Open tasks (context chip)
        pool.query(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE user_id = $1 AND completed = false AND archived = false
             AND (due_date IS NULL OR due_date >= CURRENT_DATE - INTERVAL '7 days')`,
          [userId]
        ).catch(() => ({ rows: [{ n: '0' }] })),

        // Tasks completed today (momentum traction pillar)
        pool.query(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE user_id = $1 AND is_completed = true
             AND (updated_at AT TIME ZONE $2)::date = $3::date`,
          [userId, tz, today]
        ).catch(() => ({ rows: [{ n: '0' }] })),

        // Routines completed today (momentum rhythm pillar)
        pool.query(
          `SELECT COUNT(*) AS n FROM routine_streaks rs
           JOIN routines r ON r.id = rs.routine_id
           WHERE r.user_id = $1 AND rs.last_completed_date = $2`,
          [userId, today]
        ).catch(() => ({ rows: [{ n: '0' }] })),

        // Buddy check-ins today — returns each row's type so we can derive
        // morning/evening flags AND connection score from one query
        pool.query(
          `SELECT checkin_type FROM buddy_checkins
           WHERE user_id = $1 AND (created_at AT TIME ZONE $2)::date = $3::date`,
          [userId, tz, today]
        ).catch(() => ({ rows: [] })),

        // New buddy message in last 5 minutes
        pool.query(
          `SELECT COUNT(*) AS cnt FROM buddy_conversations
           WHERE user_id = $1 AND role = 'buddy'
             AND created_at > NOW() - INTERVAL '5 minutes'`,
          [userId]
        ).catch(() => ({ rows: [{ cnt: '0' }] })),

        // Missed routine (for context proactive prompt)
        pool.query(
          `SELECT r.id, r.name FROM routines r
           LEFT JOIN routine_streaks rs ON rs.routine_id = r.id AND rs.user_id = $1
           WHERE r.user_id = $1 AND r.is_active = true
             AND r.nudge_after_hour > 0 AND r.nudge_after_hour <= $2
             AND (rs.current_streak = 0 OR rs.current_streak IS NULL)
             AND r.created_at < CURRENT_DATE
           LIMIT 1`,
          [userId, localHour]
        ).catch(() => ({ rows: [] })),

        // All expense stats in one table scan (30-day window covers all three uses):
        //   untriaged_30d → stats chip (was /context, 30d window)
        //   untriaged_7d  → money badge (was /notification-count, 7d window)
        //   today_total/impulse/planned → money card spend
        //   reviewed_week → momentum awareness pillar
        pool.query(
          `SELECT
             COALESCE(SUM(amount) FILTER (WHERE expense_date = $2), 0)                               AS today_total,
             COALESCE(SUM(amount) FILTER (WHERE is_impulse = true  AND expense_date = $2), 0)        AS today_impulse,
             COALESCE(SUM(amount) FILTER (WHERE is_impulse = false AND expense_date = $2), 0)        AS today_planned,
             COUNT(*) FILTER (WHERE is_impulse IS NULL AND source = 'plaid')                         AS untriaged_30d,
             COUNT(*) FILTER (WHERE is_impulse IS NULL AND source = 'plaid'
                                AND expense_date >= CURRENT_DATE - INTERVAL '7 days')                AS untriaged_7d,
             COUNT(*) FILTER (WHERE is_impulse IS NOT NULL AND expense_date >= $3)                   AS reviewed_week
           FROM expenses
           WHERE user_id = $1 AND expense_date >= CURRENT_DATE - INTERVAL '30 days'`,
          [userId, today, weekStartStr]
        ).catch(() => ({ rows: [{ today_total: 0, today_impulse: 0, today_planned: 0, untriaged_30d: 0, untriaged_7d: 0, reviewed_week: 0 }] })),
      ]);

      // ── Derive values ────────────────────────────────────────────────────────
      const incompleteTaskCount  = parseInt(incompleteRes.rows[0]?.n  || 0, 10);
      const completedToday       = parseInt(completedRes.rows[0]?.n   || 0, 10);
      const routinesCompletedToday = parseInt(rhythmRes.rows[0]?.n    || 0, 10);

      const checkinTypes = new Set(checkinsRes.rows.map(r => r.checkin_type));
      const morningCheckinDone = checkinTypes.has('morning');
      const eveningCheckinDone = checkinTypes.has('evening');

      const hasNewBuddyMessage = parseInt(buddyMsgRes.rows[0]?.cnt || 0, 10) > 0;
      const routineMissed = missedRouteRes.rows.length > 0;

      const exp = expensesRes.rows[0] || {};
      const unclassifiedCount  = parseInt(exp.untriaged_30d || 0, 10);
      const badgeCount         = parseInt(exp.untriaged_7d  || 0, 10);
      const reviewedExpenses   = parseInt(exp.reviewed_week || 0, 10);
      const todayTotal         = parseFloat(exp.today_total  || 0);
      const todayImpulse       = parseFloat(exp.today_impulse || 0);
      const todayPlanned       = parseFloat(exp.today_planned || 0);

      // ── Momentum score ───────────────────────────────────────────────────────
      const tractionScore    = Math.min(completedToday / 3, 1) * 100;
      const rhythmScore      = routinesCompletedToday > 0 ? 100 : 0;
      const connectionScore  = (morningCheckinDone ? 50 : 0) + (eveningCheckinDone ? 50 : 0);
      const awarenessScore   = reviewedExpenses > 0 ? 100 : 0;
      const momentumScore    = Math.round(
        tractionScore   * 0.40 +
        rhythmScore     * 0.25 +
        connectionScore * 0.20 +
        awarenessScore  * 0.15
      );

      let momentumMessage;
      if (momentumScore === 0)       momentumMessage = 'Ready to start? One task or check-in gets things moving.';
      else if (momentumScore <= 20)  momentumMessage = 'Getting going — every bit of traction counts.';
      else if (momentumScore <= 49)  momentumMessage = 'Building momentum. Each step stacks on the last.';
      else if (momentumScore <= 69)  momentumMessage = 'Good momentum. You\'re showing up for yourself.';
      else if (momentumScore <= 84)  momentumMessage = 'Strong day. This is what consistency looks like.';
      else                           momentumMessage = 'You\'re in flow today.';

      res.json({
        success: true,

        // User identity
        user: { name: user.name || null, email: user.email || null },

        // Context (was /api/buddy-widget/context)
        incompleteTaskCount,
        unclassifiedCount,
        isEveningTime,
        eveningCheckinDone,
        morningCheckinDone,
        routineMissed,
        hasNewBuddyMessage,
        sessionComplete: eveningCheckinDone,
        routineName: routineMissed ? missedRouteRes.rows[0]?.name : null,

        // Notification badge (was /api/buddy-widget/notification-count)
        badgeCount,
        eveningReady: !eveningCheckinDone,

        // Momentum (was /api/momentum-score)
        momentum: {
          score:   momentumScore,
          message: momentumMessage,
          pillars: {
            traction:   { score: Math.round(tractionScore),  label: 'Tasks done',      note: `${completedToday} task${completedToday === 1 ? '' : 's'} completed today` },
            rhythm:     { score: rhythmScore,                 label: 'Routine rhythm',  note: routinesCompletedToday > 0 ? `${routinesCompletedToday} routine${routinesCompletedToday === 1 ? '' : 's'} done` : 'No routines completed yet' },
            connection: { score: connectionScore,             label: 'Buddy check-in',  note: connectionScore === 100 ? 'Morning + evening done' : connectionScore === 50 ? 'One check-in done' : 'No check-in yet today' },
            awareness:  { score: awarenessScore,              label: 'Spending review', note: reviewedExpenses > 0 ? `${reviewedExpenses} expense${reviewedExpenses === 1 ? '' : 's'} reviewed this week` : 'No expenses reviewed this week' },
          },
        },

        // Today's spend (was /api/money/expenses/today)
        todaySpend: {
          total:   todayTotal,
          impulse: todayImpulse,
          planned: todayPlanned,
        },
      });
    } catch (err) {
      console.error('[home-context] Error:', err.message);
      res.status(500).json({ success: false, message: 'Could not load home context' });
    }
  });

  return router;
};
