'use strict';
/**
 * routes/spending-sessions.js — Spending Classification Session API.
 *
 * Owns: /api/v1/spending-sessions/* endpoints (the spending check-in at
 *       public/checkin-spending.html: sessions, classification, stats, insights).
 * The queue is the user's real bank charges (see services/ClassificationService.js);
 * classify writes through the money tab's db functions.
 * Does NOT own: Plaid sync, budget tracking.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { ClassificationService } = require('../services/ClassificationService');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

const { NotFoundError } = ClassificationService;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Route :id → positive int session id, or null. */
function sessionIdParam(raw) {
  return /^\d{1,10}$/.test(String(raw)) && Number(raw) > 0 && Number(raw) <= 2147483647 ? Number(raw) : null;
}

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ── POST /api/spending-sessions/start ─────────────────────────────────────
  // Creates or returns today's session; loads unclassified transaction count.
  router.post('/start', async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await ClassificationService.start_session(pool, userId);
      res.json({
        session_id: result.session_id,
        session_date: result.session_date,
        transaction_count: result.transaction_count,
      });
    } catch (err) {
      console.error('[spending-sessions] Error starting session:', err);
      res.status(500).json({ success: false, message: 'Failed to start session' });
    }
  });

  // ── GET /api/spending-sessions/today ──────────────────────────────────────
  // Returns today's session with classifications and transaction list.
  router.get('/today', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const sessionDate = getUserLocalDate(tz);

      const session = await ClassificationService.get_session(pool, userId, sessionDate);
      if (!session) {
        return res.json({ success: true, session: null });
      }

      res.json({
        success: true,
        session_id: session.session_id,
        date: session.date,
        classifications: session.classifications,
        complete: session.complete,
        impulse_count: session.impulse_count,
        planned_count: session.planned_count,
        transaction_count: session.transaction_count,
        transactions: session.transactions,
      });
    } catch (err) {
      console.error('[spending-sessions] Error fetching today session:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch session' });
    }
  });

  // ── POST /api/v1/spending-sessions/:id/classify ─────────────────────────────
  // Body: { transaction_id: 'pt:<id>' | 'exp:<id>', classification: 'planned'|'impulse' }.
  // Writes the expense (is_impulse) the same way the money tab does; re-swiping
  // updates it (no duplicates).
  router.post('/:id/classify', async (req, res) => {
    try {
      const userId = req.user.id;
      const sessionId = sessionIdParam(req.params.id);
      const { transaction_id, classification } = req.body || {};

      if (!sessionId) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }
      if (!transaction_id) {
        return res.status(400).json({ success: false, message: 'transaction_id required' });
      }
      if (!classification || !['planned', 'impulse'].includes(classification)) {
        return res.status(400).json({ success: false, message: 'classification must be "planned" or "impulse"' });
      }

      const expense = await ClassificationService.classify(pool, userId, String(transaction_id), classification, sessionId);
      res.json({ ok: true, expense_id: expense.id, is_impulse: expense.is_impulse });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ success: false, message: 'Transaction not found' });
      }
      console.error('[spending-sessions] Error classifying transaction:', err.message, '| userId:', req.user && req.user.id);
      res.status(500).json({ success: false, message: 'Failed to classify transaction' });
    }
  });

  // ── POST /api/v1/spending-sessions/:id/complete ─────────────────────────────
  // Mark the user's spending session as complete.
  router.post('/:id/complete', async (req, res) => {
    try {
      const userId = req.user.id;
      const sessionId = sessionIdParam(req.params.id);
      if (!sessionId) return res.status(404).json({ success: false, message: 'Session not found' });

      await ClassificationService.complete_session(pool, userId, sessionId);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }
      console.error('[spending-sessions] Error completing session:', err.message, '| userId:', req.user && req.user.id);
      res.status(500).json({ success: false, message: 'Failed to complete session' });
    }
  });

  // ── GET /api/spending-sessions/stats ──────────────────────────────────────
  // Returns classification stats for a date range.
  // Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to last 30 days)
  router.get('/stats', async (req, res) => {
    try {
      const userId = req.user.id;
      const { from, to } = req.query;

      // Default: the user's last 30 local days. Bad dates fall back too.
      const today = await ClassificationService.localToday(pool, userId);
      const fromDate = DATE_RE.test(from || '') ? from : ClassificationService.minusDays(today, 29);
      const toDate = DATE_RE.test(to || '') ? to : today;

      const stats = await ClassificationService.get_stats(pool, userId, { from: fromDate, to: toDate });

      res.json({
        success: true,
        total_classified: stats.total_classified,
        impulse_count: stats.impulse_count,
        planned_count: stats.planned_count,
        impulse_pct: stats.impulse_pct,
        by_category: stats.by_category,
      });
    } catch (err) {
      console.error('[spending-sessions] Error fetching stats:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch stats' });
    }
  });

  // ── GET /api/spending-sessions/insights ───────────────────────────────────
  // Returns top 3 recent spending insights for the dashboard.
  router.get('/insights', async (req, res) => {
    try {
      const userId = req.user.id;
      const insights = await ClassificationService.get_recent_insights(pool, userId);
      res.json({ success: true, insights });
    } catch (err) {
      console.error('[spending-sessions] Error fetching insights:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch insights' });
    }
  });

  return router;
};