/**
 * Momentum Score — daily 0–100 signal showing what's working today.
 *
 * Salutogenic framing (Antonovsky): measures positive behaviors, not failures.
 * Every pillar is something the user DID, not something they failed to do.
 *
 * GET /api/momentum-score
 *
 * Formula:
 *   Traction   (40%) — tasks completed today (3 = full marks; scales linearly)
 *   Rhythm     (25%) — any routine completed today
 *   Connection (20%) — Buddy check-in today (morning 50pts, evening 50pts)
 *   Awareness  (15%) — any expense reviewed (planned/impulse) this week
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

      // Resolve user's local date
      const tzRow = await pool.query(
        'SELECT COALESCE(timezone, \'UTC\') AS tz FROM users WHERE id = $1',
        [userId]
      );
      const tz = tzRow.rows[0]?.tz || 'UTC';
      const today = getUserLocalDate(tz);

      // Week start (Monday)
      const d = new Date(today + 'T12:00:00Z');
      const dayOfWeek = d.getUTCDay();
      const diff = d.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      const weekStart = new Date(d);
      weekStart.setUTCDate(diff);
      const weekStartStr = weekStart.toISOString().slice(0, 10);

      // Run all four pillar queries in parallel
      const [tractionRes, rhythmRes, connectionRes, awarenessRes] = await Promise.all([
        // Traction: tasks completed today (timezone-aware via AT TIME ZONE)
        pool.query(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE user_id = $1
             AND is_completed = true
             AND (updated_at AT TIME ZONE $2)::date = $3::date`,
          [userId, tz, today]
        ).catch(() => ({ rows: [{ n: '0' }] })),

        // Rhythm: any routine completed today
        pool.query(
          `SELECT COUNT(*) AS n FROM routine_streaks rs
           JOIN routines r ON r.id = rs.routine_id
           WHERE r.user_id = $1
             AND rs.last_completed_date = $2`,
          [userId, today]
        ).catch(() => ({ rows: [{ n: '0' }] })),

        // Connection: Buddy check-ins today
        pool.query(
          `SELECT type FROM buddy_checkins
           WHERE user_id = $1
             AND (created_at AT TIME ZONE $2)::date = $3::date`,
          [userId, tz, today]
        ).catch(() => ({ rows: [] })),

        // Awareness: expenses reviewed (triaged) this week
        pool.query(
          `SELECT COUNT(*) AS n FROM expenses
           WHERE user_id = $1
             AND is_impulse IS NOT NULL
             AND expense_date >= $2`,
          [userId, weekStartStr]
        ).catch(() => ({ rows: [{ n: '0' }] })),
      ]);

      // ── Pillar scores (each 0–100) ────────────────────────────────
      const completedToday = parseInt(tractionRes.rows[0]?.n || 0, 10);
      const tractionScore = Math.min(completedToday / 3, 1) * 100;

      const routinesCompletedToday = parseInt(rhythmRes.rows[0]?.n || 0, 10);
      const rhythmScore = routinesCompletedToday > 0 ? 100 : 0;

      const checkinTypes = new Set(connectionRes.rows.map(r => r.type));
      const connectionScore = (checkinTypes.has('morning') ? 50 : 0) +
                              (checkinTypes.has('evening') ? 50 : 0);

      const reviewedExpenses = parseInt(awarenessRes.rows[0]?.n || 0, 10);
      const awarenessScore = reviewedExpenses > 0 ? 100 : 0;

      // ── Overall score ─────────────────────────────────────────────
      const score = Math.round(
        tractionScore  * 0.40 +
        rhythmScore    * 0.25 +
        connectionScore * 0.20 +
        awarenessScore * 0.15
      );

      // ── Encourage without shaming ─────────────────────────────────
      let message;
      if (score === 0)        message = 'Ready to start? One task or check-in gets things moving.';
      else if (score <= 20)   message = 'Getting going — every bit of traction counts.';
      else if (score <= 49)   message = 'Building momentum. Each step stacks on the last.';
      else if (score <= 69)   message = 'Good momentum. You\'re showing up for yourself.';
      else if (score <= 84)   message = 'Strong day. This is what consistency looks like.';
      else                    message = 'You\'re in flow today.';

      res.json({
        success: true,
        score,
        message,
        pillars: {
          traction:   { score: Math.round(tractionScore),   weight: 0.40, label: 'Tasks done',       note: `${completedToday} task${completedToday === 1 ? '' : 's'} completed today` },
          rhythm:     { score: rhythmScore,                  weight: 0.25, label: 'Routine rhythm',   note: routinesCompletedToday > 0 ? `${routinesCompletedToday} routine${routinesCompletedToday === 1 ? '' : 's'} done` : 'No routines completed yet' },
          connection: { score: connectionScore,              weight: 0.20, label: 'Buddy check-in',   note: connectionScore === 100 ? 'Morning + evening done' : connectionScore === 50 ? 'One check-in done' : 'No check-in yet today' },
          awareness:  { score: awarenessScore,               weight: 0.15, label: 'Spending review',  note: reviewedExpenses > 0 ? `${reviewedExpenses} expense${reviewedExpenses === 1 ? '' : 's'} reviewed this week` : 'No expenses reviewed this week' },
        },
      });
    } catch (err) {
      console.error('[MomentumScore] Error:', err.message);
      res.status(500).json({ success: false, message: 'Could not compute score' });
    }
  });

  return router;
};
