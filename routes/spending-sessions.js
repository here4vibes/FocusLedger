'use strict';
/**
 * routes/spending-sessions.js — Spending Classification Session API.
 *
 * Owns: /api/spending-sessions/* endpoints (classification, sessions, stats, insights).
 * Does NOT own: Plaid sync, expense creation, budget tracking.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { ClassificationService } = require('../services/ClassificationService');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

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
        transaction_count: session.transaction_count,
        transactions: session.transactions,
      });
    } catch (err) {
      console.error('[spending-sessions] Error fetching today session:', err);
      res.status(500).json({ success: false, message: 'Failed to fetch session' });
    }
  });

  // ── POST /api/spending-sessions/:id/classify ──────────────────────────────
  // Classify a transaction as 'planned' or 'impulse'.
  // Upserts — re-swiping updates the existing record (no duplicates).
  router.post('/:id/classify', async (req, res) => {
    try {
      const userId = req.user.id;
      const { id: sessionId } = req.params;
      const { transaction_id, classification } = req.body;

      if (!transaction_id) {
        return res.status(400).json({ success: false, message: 'transaction_id required' });
      }
      if (!classification || !['planned', 'impulse'].includes(classification)) {
        return res.status(400).json({ success: false, message: 'classification must be "planned" or "impulse"' });
      }

      await ClassificationService.classify(pool, userId, transaction_id, classification, sessionId);
      res.json({ ok: true });
    } catch (err) {
      if (err.message.includes('not found')) {
        return res.status(404).json({ success: false, message: err.message });
      }
      console.error('[spending-sessions] Error classifying transaction:', err);
      res.status(500).json({ success: false, message: 'Failed to classify transaction' });
    }
  });

  // ── POST /api/spending-sessions/:id/complete ───────────────────────────────
  // Mark a spending session as complete.
  router.post('/:id/complete', async (req, res) => {
    try {
      const userId = req.user.id;
      const { id: sessionId } = req.params;

      await ClassificationService.complete_session(pool, userId, sessionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[spending-sessions] Error completing session:', err);
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

      // Default: last 30 days
      const today = new Date();
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const fromDate = from || thirtyDaysAgo.toISOString().split('T')[0];
      const toDate = to || today.toISOString().split('T')[0];

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