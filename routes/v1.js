'use strict';
/**
 * routes/v1.js — v1 API: Plaid + Transaction endpoints under /api/v1/.
 *
 * Owns: POST /plaid/connect, DELETE /plaid/disconnect, GET /accounts,
 *       GET /transactions, GET /transactions/today,
 *       GET /transactions/:id, GET /transactions/aggregate.
 *
 * Does NOT own: v0 /api/plaid/* (see routes/plaid.js),
 *               v0 /api/expenses/* (see routes/expenses.js).
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { checkProStatus } = require('../middleware/proUtils');
const { connect, disconnect, getAccounts } = require('../services/PlaidService');
const { list, getToday, getAggregate, get_transaction_with_classification, update_classification } = require('../services/TransactionService');

module.exports = function(pool) {
  const router = express.Router();

  // All v1 routes require authentication
  router.use(authenticateToken);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  async function requirePro(req) {
    const isPro = await checkProStatus(pool, req.user.id);
    if (!isPro) {
      const err = new Error('Bank sync is an Autopilot feature.');
      err.status = 403;
      throw err;
    }
  }

  // ── POST /api/v1/plaid/connect ───────────────────────────────────────────────
  router.post('/plaid/connect', async (req, res) => {
    try {
      await requirePro(req);

      const { public_token } = req.body;
      if (!public_token) {
        return res.status(400).json({ success: false, message: 'public_token required' });
      }

      const result = await connect(pool, req.user.id, public_token);

      res.json({ connected: true, institution: result.institution });
    } catch (err) {
      if (err.message === 'PLAID_NOT_CONFIGURED') {
        return res.status(503).json({
          success: false,
          message: 'Bank sync is being set up — we will have this ready shortly.',
        });
      }
      console.error('[v1/plaid/connect]', err.response?.data || err.message);
      res.status(500).json({ success: false, message: 'Connection did not go through.' });
    }
  });

  // ── DELETE /api/v1/plaid/disconnect ──────────────────────────────────────────
  router.delete('/plaid/disconnect', async (req, res) => {
    try {
      await disconnect(pool, req.user.id);
      res.json({ disconnected: true });
    } catch (err) {
      console.error('[v1/plaid/disconnect]', err.message);
      res.status(500).json({ success: false, message: 'Disconnect did not complete.' });
    }
  });

  // ── GET /api/v1/accounts ──────────────────────────────────────────────────────
  // Returns Plaid account info with balances for the Account Summary card.
  router.get('/accounts', async (req, res) => {
    try {
      const result = await getAccounts(pool, req.user.id);
      res.json(result);
    } catch (err) {
      console.error('[v1/accounts]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch accounts' });
    }
  });

  // ── GET /api/v1/transactions ─────────────────────────────────────────────────
  router.get('/transactions', async (req, res) => {
    try {
      const { from, to, category, classification, search, limit, offset } = req.query;

      const result = await list(pool, req.user.id, { from, to, category, classification, search, limit, offset });

      res.json(result);
    } catch (err) {
      console.error('[v1/transactions]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
    }
  });

  // ── GET /api/v1/transactions/today ───────────────────────────────────────────
  router.get('/transactions/today', async (req, res) => {
    try {
      const transactions = await getToday(pool, req.user.id);
      res.json({ transactions });
    } catch (err) {
      console.error('[v1/transactions/today]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch today transactions' });
    }
  });

  // ── GET /api/v1/transactions/:id ─────────────────────────────────────────────
  router.get('/transactions/:id', async (req, res) => {
    try {
      const { id } = req.params;

      const transaction = await get_transaction_with_classification(pool, id, req.user.id);

      if (!transaction) {
        return res.status(404).json({ success: false, message: 'Transaction not found' });
      }

      res.json({ transaction });
    } catch (err) {
      console.error('[v1/transactions/:id]', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch transaction' });
    }
  });

  // ── PATCH /api/v1/transactions/:id ──────────────────────────────────────────
  // Update transaction classification: { classification: 'planned' | 'impulse' }
  router.patch('/transactions/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { classification } = req.body;

      if (!classification || !['planned', 'impulse'].includes(classification)) {
        return res.status(400).json({ success: false, message: 'classification must be "planned" or "impulse"' });
      }

      const existing = await get_transaction_with_classification(pool, id, req.user.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Transaction not found' });
      }

      await update_classification(pool, id, req.user.id, classification);

      const transaction = await get_transaction_with_classification(pool, id, req.user.id);
      res.json({ success: true, transaction });
    } catch (err) {
      console.error('[v1/transactions/:id PATCH]', err.message);
      res.status(500).json({ success: false, message: 'Failed to update classification' });
    }
  });

  // ── POST /api/v1/transactions/:id/triage ─────────────────────────────────────
  // Classify a transaction as planned or impulse — called from Evening Swipe or Money page.
  // Same as PATCH but simpler body: { classification: 'planned' | 'impulse' }
  router.post('/transactions/:id/triage', async (req, res) => {
    try {
      const { id } = req.params;
      const { classification } = req.body;

      if (!classification || !['planned', 'impulse'].includes(classification)) {
        return res.status(400).json({ success: false, message: 'classification must be "planned" or "impulse"' });
      }

      const existing = await get_transaction_with_classification(pool, id, req.user.id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Transaction not found' });
      }

      await update_classification(pool, id, req.user.id, classification);

      const transaction = await get_transaction_with_classification(pool, id, req.user.id);
      res.json({ success: true, transaction });
    } catch (err) {
      console.error('[v1/transactions/:id/triage POST]', err.message);
      res.status(500).json({ success: false, message: 'Failed to classify transaction' });
    }
  });

  // ── GET /api/v1/transactions/aggregate ──────────────────────────────────────
  router.get('/transactions/aggregate', async (req, res) => {
    try {
      const { from, to } = req.query;

      const aggregate = await getAggregate(pool, req.user.id, { from, to });

      res.json(aggregate);
    } catch (err) {
      console.error('[v1/transactions/aggregate]', err.message);
      res.status(500).json({ success: false, message: 'Failed to compute aggregate' });
    }
  });

  return router;
};