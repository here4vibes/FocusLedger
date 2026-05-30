'use strict';
/**
 * routes/check-in.js — Evening Check-In spending swipe API.
 *
 * Owns: GET /evening/spending (unclassified transactions for today),
 *       POST /evening/spending/:transactionId/classify (upsert classification).
 *
 * Does NOT own: spending sessions flow (see routes/spending-sessions.js),
 *               v1 transaction CRUD (see routes/v1.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  getUnclassifiedByDate,
  updateClassification,
  getTodayClassificationCounts,
} = require('../db/transactions');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ── GET /api/v1/check-in/evening/spending ─────────────────────────────────
  // Returns today's unclassified transactions for the swipe card UI.
  // Shape: [{ id, merchant, amount, category, date }]
  router.get('/evening/spending', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      const rows = await getUnclassifiedByDate(pool, userId, today);

      const transactions = rows.map(t => ({
        id:       t.id,
        merchant: t.merchant_name || 'Unknown merchant',
        amount:   t.amount,
        category: t.category || null,
        date:     t.date,
      }));

      res.json({ transactions });
    } catch (err) {
      console.error('[check-in/evening/spending GET]', err.message);
      res.status(500).json({ success: false, message: 'Failed to load spending' });
    }
  });

  // ── POST /api/v1/check-in/evening/spending/:transactionId/classify ─────────
  // Body: { classification: 'impulse' | 'planned' }
  // Upserts into transaction_classifications for this user.
  router.post('/evening/spending/:transactionId/classify', async (req, res) => {
    try {
      const userId        = req.user.id;
      const { transactionId } = req.params;
      const { classification } = req.body;

      if (!classification || !['impulse', 'planned'].includes(classification)) {
        return res.status(400).json({
          success: false,
          message: 'classification must be "impulse" or "planned"',
        });
      }

      await updateClassification(pool, transactionId, userId, classification);

      res.json({ success: true });
    } catch (err) {
      console.error('[check-in/evening/spending POST]', err.message);
      res.status(500).json({ success: false, message: 'Failed to save classification' });
    }
  });

  // ── GET /api/v1/check-in/evening/spending/summary ─────────────────────────
  // Returns today's classification counts for the Money Dashboard breakdown line.
  // Shape: { impulse, planned, unreviewed, total }
  router.get('/evening/spending/summary', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      const counts = await getTodayClassificationCounts(pool, userId, today);
      res.json(counts);
    } catch (err) {
      console.error('[check-in/evening/spending/summary]', err.message);
      res.status(500).json({ success: false, message: 'Failed to load summary' });
    }
  });

  return router;
};

// ── Stub: evening swipe push notification ─────────────────────────────────────
// WHY: Push notification wiring is out of scope for this slice.
// When wired, this should enqueue an APNs/Web Push delivery to the user's device.
function scheduleEveningSwipePush(userId) {
  console.log('[check-in] scheduleEveningSwipePush intent logged for user', userId);
  // TODO: wire to push-tokens table + APNs delivery when notification layer is ready
}

module.exports.scheduleEveningSwipePush = scheduleEveningSwipePush;
