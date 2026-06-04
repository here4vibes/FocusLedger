'use strict';
/**
 * services/ClassificationService.js — Core classification logic for spending sessions.
 *
 * Owns: transaction classification (planned vs impulse), session lifecycle,
 *       event emission. Does NOT own: Plaid sync, expense creation, budget logic.
 *
 * Events emitted:
 *   - 'transaction.classified': { user_id, transaction_id, classification,
 *       merchant_name, amount, category }
 *   - 'spending_session.complete': { user_id, session_id, impulse_count,
 *       planned_count, total_spend_cents }
 */

const spendingDB = require('../db/spendingSessions');
const txDB = require('../db/transactions');
const { eventBus } = require('./EventBus');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

const VALID_CLASSIFICATIONS = new Set(['planned', 'impulse']);

const ClassificationService = {
  /**
   * Upsert a classification for a transaction.
   * Re-swiping updates the existing record (no duplicates).
   * Emits 'transaction.classified' event on every upsert.
   *
   * @param {object} pool
   * @param {number} userId
   * @param {string} transactionId  - UUID of the transaction
   * @param {string} classification  - 'planned' | 'impulse'
   * @param {string} sessionId      - UUID of the owning session
   * @returns {Promise<object>} upserted classification row
   */
  async classify(pool, userId, transactionId, classification, sessionId) {
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      throw new Error(`Invalid classification: ${classification}. Must be 'planned' or 'impulse'.`);
    }

    // Load transaction details for event payload
    const tx = await txDB.getById(pool, transactionId, userId);
    if (!tx) {
      throw new Error(`Transaction ${transactionId} not found for user ${userId}`);
    }

    // Upsert classification (ON CONFLICT updates existing row)
    const result = await spendingDB.upsertClassification(pool, {
      sessionId,
      userId,
      transactionId,
      classification,
    });

    // Emit event with full transaction context
    eventBus.emit('transaction.classified', {
      user_id: userId,
      transaction_id: transactionId,
      classification,
      merchant_name: tx.merchant_name,
      amount: tx.amount,  // cents
      category: tx.category,
    });

    return result;
  },

  /**
   * Get a spending session with its classifications and transaction list.
   * @param {object} pool
   * @param {number} userId
   * @param {string} sessionDate  - YYYY-MM-DD
   * @returns {Promise<object>} session + classifications + transaction count
   */
  async get_session(pool, userId, sessionDate) {
    const session = await spendingDB.getSession(pool, userId, sessionDate);
    if (!session) {
      return null;
    }

    const [classifications, transactions] = await Promise.all([
      spendingDB.getClassificationsForSession(pool, session.id),
      txDB.getByDate(pool, userId, sessionDate),
    ]);

    return {
      session_id: session.id,
      date: session.session_date,
      classifications: classifications.map(c => ({
        transaction_id: c.transaction_id,
        classification: c.classification,
        merchant_name: c.merchant_name,
        amount: c.amount,
        category: c.category,
        swiped_at: c.swiped_at,
      })),
      complete: session.complete,
      transaction_count: transactions.length,
      transactions: transactions.map(t => ({
        id: t.id,
        merchant_name: t.merchant_name,
        amount: t.amount,
        category: t.category,
        category_icon: t.category_icon,
        date: t.date,
        logo_url: t.logo_url,
        classification: t.classification || null,
        swiped_at: t.swiped_at || null,
      })),
    };
  },

  /**
   * Start a new (or return existing) spending session for today.
   * Loads unclassified transaction count from TransactionService.
   * @param {object} pool
   * @param {number} userId
   * @returns {Promise<object>} { session_id, session_date, transaction_count }
   */
  async start_session(pool, userId) {
    const tz = await fetchUserTimezone(pool, userId);
    const sessionDate = getUserLocalDate(tz);

    const TransactionService = require('./TransactionService');
    const count = await TransactionService.count_unclassified(pool, userId, sessionDate);

    const session = await spendingDB.upsertSession(pool, userId, sessionDate, count);

    return {
      session_id: session.id,
      session_date: session.session_date,
      transaction_count: count,
    };
  },

  /**
   * Mark a spending session as complete.
   * Emits 'spending_session.complete' event with classification counts.
   * @param {object} pool
   * @param {number} userId
   * @param {string} sessionId  - UUID
   * @returns {Promise<void>}
   */
  async complete_session(pool, userId, sessionId) {
    // Count classifications for event payload
    const classifications = await spendingDB.getClassificationsForSession(pool, sessionId);
    const impulseCount = classifications.filter(c => c.classification === 'impulse').length;
    const plannedCount = classifications.filter(c => c.classification === 'planned').length;
    const totalSpendCents = classifications.reduce((sum, c) => sum + (parseInt(c.amount, 10) || 0), 0);

    await spendingDB.completeSession(pool, sessionId);

    eventBus.emit('spending_session.complete', {
      user_id: userId,
      session_id: sessionId,
      impulse_count: impulseCount,
      planned_count: plannedCount,
      total_spend_cents: totalSpendCents,
    });
  },

  /**
   * Get classification stats for a user within a date range.
   * @param {object} pool
   * @param {number} userId
   * @param {object} opts  - { from: YYYY-MM-DD, to: YYYY-MM-DD }
   * @returns {Promise<object>} stats
   */
  async get_stats(pool, userId, opts) {
    return spendingDB.getClassificationStats(pool, userId, opts.from, opts.to);
  },

  /**
   * Get top 3 recent insights for the dashboard.
   * @param {object} pool
   * @param {number} userId
   * @returns {Promise<object[]>}
   */
  async get_recent_insights(pool, userId) {
    return spendingDB.getRecentInsights(pool, userId, 3);
  },
};

module.exports = { ClassificationService };