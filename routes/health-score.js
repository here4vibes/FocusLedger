// Owns: Adulting Health Score — calculation, history, and weight preferences.
// Does NOT own: documents, tasks, expenses, plaid transactions — reads only, never writes.
//
// Endpoints:
//   GET  /api/health-score/today     — get (or calculate) today's score
//   GET  /api/health-score/history   — last 30 days of scores
//   GET  /api/health-score/weights   — current component weights
//   PUT  /api/health-score/weights   — update component weights (must sum to 100)
//   POST /api/health-score/recalculate — force recalculate today (dev/debug)

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

// ─── Score component calculators ──────────────────────────────────────────────

// Documents score (0–max): points for vault populated, nothing expired, key categories covered.
async function calcDocumentsScore(pool, userId, max) {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date < NOW() THEN 1 END) as expired,
         COUNT(CASE WHEN expiry_date IS NOT NULL AND expiry_date BETWEEN NOW() AND NOW() + INTERVAL '30 days' THEN 1 END) as expiring_soon
       FROM documents
       WHERE user_id = $1`,
      [userId]
    );
    const { total, expired, expiring_soon } = result.rows[0];
    const totalN = parseInt(total, 10);
    const expiredN = parseInt(expired, 10);
    const expiringSoonN = parseInt(expiring_soon, 10);

    if (totalN === 0) return { score: 0, factors: ['No documents in vault'] };

    let raw = 0;
    const factors = [];

    // Base: having documents at all (up to 60% of max)
    const basePoints = Math.min(Math.round((totalN / 5) * max * 0.6), Math.round(max * 0.6));
    raw += basePoints;
    factors.push(`${totalN} document${totalN !== 1 ? 's' : ''} stored`);

    // Penalty: expired documents
    if (expiredN > 0) {
      const penalty = Math.round((expiredN / totalN) * max * 0.4);
      raw = Math.max(0, raw - penalty);
      factors.push(`${expiredN} expired document${expiredN !== 1 ? 's' : ''}`);
    } else {
      raw += Math.round(max * 0.25);
      factors.push('Nothing expired');
    }

    // Small penalty: expiring soon
    if (expiringSoonN > 0) {
      factors.push(`${expiringSoonN} expiring within 30 days`);
    } else if (expiredN === 0) {
      raw += Math.round(max * 0.15);
      factors.push('All documents current');
    }

    return { score: Math.min(max, Math.round(raw)), factors };
  } catch {
    return { score: 0, factors: ['Unable to read documents'] };
  }
}

// Insurance score (0–max): placeholder until Phase 1B insurance table ships.
// Gives partial credit if documents contain insurance-category files.
async function calcInsuranceScore(pool, userId, max) {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as total
       FROM documents
       WHERE user_id = $1 AND LOWER(category) IN ('insurance', 'health insurance', 'auto insurance', 'home insurance', 'life insurance', 'renter''s insurance')`,
      [userId]
    );
    const total = parseInt(result.rows[0].total, 10);
    if (total === 0) {
      return { score: 0, factors: ['No insurance documents on file'] };
    }
    // Partial credit: each insurance doc worth points, capped at max
    const points = Math.min(max, Math.round((total / 4) * max));
    return {
      score: points,
      factors: [`${total} insurance document${total !== 1 ? 's' : ''} on file`, 'Full insurance tracking coming soon']
    };
  } catch {
    return { score: 0, factors: ['Insurance tracking coming soon'] };
  }
}

// Tasks score (0–max): weekly completion rate.
async function calcTasksScore(pool, userId, max) {
  try {
    // Tasks with a due date in the current week (Mon–Sun)
    const result = await pool.query(
      `SELECT
         COUNT(*) as total_due,
         COUNT(CASE WHEN is_completed = true THEN 1 END) as completed
       FROM tasks
       WHERE user_id = $1
         AND due_date >= date_trunc('week', NOW())
         AND due_date < date_trunc('week', NOW()) + INTERVAL '7 days'`,
      [userId]
    );
    const totalDue = parseInt(result.rows[0].total_due, 10);
    const completed = parseInt(result.rows[0].completed, 10);

    // If no tasks due this week, score based on general completion rate (last 30 days)
    if (totalDue === 0) {
      const generalResult = await pool.query(
        `SELECT
           COUNT(*) as total,
           COUNT(CASE WHEN is_completed = true THEN 1 END) as completed
         FROM tasks
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
        [userId]
      );
      const gTotal = parseInt(generalResult.rows[0].total, 10);
      const gCompleted = parseInt(generalResult.rows[0].completed, 10);

      if (gTotal === 0) return { score: Math.round(max * 0.5), factors: ['No tasks yet — score is neutral'] };

      const rate = gCompleted / gTotal;
      return {
        score: Math.round(rate * max),
        factors: [`${gCompleted}/${gTotal} tasks completed in the last 30 days`]
      };
    }

    const rate = completed / totalDue;
    const factors = [`${completed}/${totalDue} tasks completed this week`];
    if (rate < 0.5) factors.push('Complete more tasks to improve');
    else if (rate >= 1) factors.push('Perfect completion this week');

    return { score: Math.round(rate * max), factors };
  } catch {
    return { score: 0, factors: ['Unable to read tasks'] };
  }
}

// Bills score (0–max): on-time payments via Plaid data.
// Uses confirmed Plaid transactions to gauge payment activity this month.
async function calcBillsScore(pool, userId, max) {
  try {
    // Check if user has any linked Plaid accounts
    const plaidCheck = await pool.query(
      'SELECT COUNT(*) as count FROM plaid_items WHERE user_id = $1',
      [userId]
    );
    const hasPlaid = parseInt(plaidCheck.rows[0].count, 10) > 0;

    if (!hasPlaid) {
      // No bank connected — give neutral score with explanation
      return {
        score: Math.round(max * 0.5),
        factors: ['Connect your bank to track bill payments', 'Score is neutral until connected']
      };
    }

    // Count confirmed transactions this month (activity = bills being paid)
    const result = await pool.query(
      `SELECT COUNT(*) as total
       FROM plaid_transactions
       WHERE user_id = $1
         AND is_confirmed = true
         AND transaction_date >= date_trunc('month', NOW())`,
      [userId]
    );
    const txCount = parseInt(result.rows[0].total, 10);

    // More activity = better score (up to 20+ confirmed txns = full score)
    if (txCount === 0) {
      return { score: Math.round(max * 0.5), factors: ['Bank connected — no confirmed transactions this month'] };
    }

    const rate = Math.min(1, txCount / 20);
    return {
      score: Math.round(rate * max),
      factors: [`${txCount} bank transaction${txCount !== 1 ? 's' : ''} confirmed this month`]
    };
  } catch {
    return { score: Math.round(max * 0.5), factors: ['Bill tracking requires bank connection'] };
  }
}

// ─── Main calculation ──────────────────────────────────────────────────────────

async function calculateScore(pool, userId) {
  // Get user weights (fallback to 25/25/25/25)
  let weights = { documents: 25, insurance: 25, tasks: 25, bills: 25 };
  try {
    const wResult = await pool.query(
      'SELECT documents, insurance, tasks, bills FROM user_score_weights WHERE user_id = $1',
      [userId]
    );
    if (wResult.rows.length > 0) {
      weights = {
        documents: parseInt(wResult.rows[0].documents, 10),
        insurance: parseInt(wResult.rows[0].insurance, 10),
        tasks: parseInt(wResult.rows[0].tasks, 10),
        bills: parseInt(wResult.rows[0].bills, 10),
      };
    }
  } catch { /* use defaults */ }

  const [docs, ins, tsk, bll] = await Promise.all([
    calcDocumentsScore(pool, userId, weights.documents),
    calcInsuranceScore(pool, userId, weights.insurance),
    calcTasksScore(pool, userId, weights.tasks),
    calcBillsScore(pool, userId, weights.bills),
  ]);

  const overall = docs.score + ins.score + tsk.score + bll.score;

  return {
    overall_score: Math.min(100, overall),
    documents_score: docs.score,
    insurance_score: ins.score,
    tasks_score: tsk.score,
    bills_score: bll.score,
    weights,
    factors: {
      documents: docs.factors,
      insurance: ins.factors,
      tasks: tsk.factors,
      bills: bll.factors,
    }
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────

const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/health-score/today — fetch or calculate today's score
  router.get('/today', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      // Check if today's score already calculated
      const existing = await pool.query(
        'SELECT * FROM health_score_history WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      if (existing.rows.length > 0) {
        // Return cached score — recalculate factors live (not stored)
        const row = existing.rows[0];
        const weights = row.weights_json;
        const [docs, ins, tsk, bll] = await Promise.all([
          calcDocumentsScore(pool, userId, weights.documents),
          calcInsuranceScore(pool, userId, weights.insurance),
          calcTasksScore(pool, userId, weights.tasks),
          calcBillsScore(pool, userId, weights.bills),
        ]);
        return res.json({
          success: true,
          score: {
            overall_score: row.overall_score,
            documents_score: row.documents_score,
            insurance_score: row.insurance_score,
            tasks_score: row.tasks_score,
            bills_score: row.bills_score,
            weights,
            factors: {
              documents: docs.factors,
              insurance: ins.factors,
              tasks: tsk.factors,
              bills: bll.factors,
            },
            calculated_at: row.created_at,
            is_cached: true,
          }
        });
      }

      // First open today — calculate and store
      const calc = await calculateScore(pool, userId);

      await pool.query(
        `INSERT INTO health_score_history
           (user_id, date, overall_score, documents_score, insurance_score, tasks_score, bills_score, weights_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, date) DO UPDATE SET
           overall_score = EXCLUDED.overall_score,
           documents_score = EXCLUDED.documents_score,
           insurance_score = EXCLUDED.insurance_score,
           tasks_score = EXCLUDED.tasks_score,
           bills_score = EXCLUDED.bills_score,
           weights_json = EXCLUDED.weights_json`,
        [userId, today, calc.overall_score, calc.documents_score,
          calc.insurance_score, calc.tasks_score, calc.bills_score, JSON.stringify(calc.weights)]
      );

      // Wire nudge system: score drop detection (7-day lookback)
      try {
        const prevResult = await pool.query(
          `SELECT overall_score FROM health_score_history
           WHERE user_id = $1 AND date < $2
           ORDER BY date DESC LIMIT 1`,
          [userId, today]
        );
        if (prevResult.rows.length > 0) {
          const prevScore = prevResult.rows[0].overall_score;
          const drop = prevScore - calc.overall_score;
          if (drop >= 10) {
            const { generateScoreDropNudge } = require('../lib/nudgeGenerator');
            generateScoreDropNudge(pool, userId, calc.overall_score, prevScore).catch(() => {});
          }
        }
      } catch { /* nudge failure is non-fatal */ }

      res.json({
        success: true,
        score: { ...calc, calculated_at: new Date().toISOString(), is_cached: false }
      });
    } catch (err) {
      console.error('[health-score/today]', err.message);
      res.status(500).json({ success: false, message: 'Failed to calculate score' });
    }
  });

  // GET /api/health-score/history — last 30 days
  router.get('/history', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(
        `SELECT date, overall_score, documents_score, insurance_score, tasks_score, bills_score
         FROM health_score_history
         WHERE user_id = $1 AND date >= NOW() - INTERVAL '30 days'
         ORDER BY date ASC`,
        [userId]
      );
      res.json({ success: true, history: result.rows });
    } catch (err) {
      console.error('[health-score/history]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
  });

  // GET /api/health-score/weights
  router.get('/weights', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await pool.query(
        'SELECT documents, insurance, tasks, bills FROM user_score_weights WHERE user_id = $1',
        [userId]
      );
      const weights = result.rows.length > 0
        ? result.rows[0]
        : { documents: 25, insurance: 25, tasks: 25, bills: 25 };
      res.json({ success: true, weights });
    } catch (err) {
      console.error('[health-score/weights]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch weights' });
    }
  });

  // PUT /api/health-score/weights — weights must sum to 100
  router.put('/weights', async (req, res) => {
    try {
      const userId = req.user.id;
      const { documents, insurance, tasks, bills } = req.body;
      const values = [documents, insurance, tasks, bills].map(v => parseInt(v, 10));

      if (values.some(isNaN) || values.some(v => v < 0 || v > 100)) {
        return res.status(400).json({ success: false, message: 'Each weight must be 0–100' });
      }
      const sum = values.reduce((a, b) => a + b, 0);
      if (sum !== 100) {
        return res.status(400).json({ success: false, message: `Weights must sum to 100 (got ${sum})` });
      }

      await pool.query(
        `INSERT INTO user_score_weights (user_id, documents, insurance, tasks, bills, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           documents = EXCLUDED.documents,
           insurance = EXCLUDED.insurance,
           tasks = EXCLUDED.tasks,
           bills = EXCLUDED.bills,
           updated_at = NOW()`,
        [userId, values[0], values[1], values[2], values[3]]
      );

      // Invalidate today's cached score so next GET /today recalculates with new weights
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);
      await pool.query(
        'DELETE FROM health_score_history WHERE user_id = $1 AND date = $2',
        [userId, today]
      );

      res.json({ success: true, weights: { documents: values[0], insurance: values[1], tasks: values[2], bills: values[3] } });
    } catch (err) {
      console.error('[health-score/weights]', err.message);
      res.status(500).json({ success: false, message: 'Failed to update weights' });
    }
  });

  // POST /api/health-score/recalculate — force recalculate (deletes today's cache)
  router.post('/recalculate', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);
      await pool.query(
        'DELETE FROM health_score_history WHERE user_id = $1 AND date = $2',
        [userId, today]
      );
      res.json({ success: true, message: 'Cache cleared — call GET /today to recalculate' });
    } catch (err) {
      console.error('[health-score/recalculate]', err.message);
      res.status(500).json({ success: false, message: 'Failed to recalculate' });
    }
  });

  return router;
};
