'use strict';
/**
 * services/TransactionService.js — Reads and manages transaction data.
 *
 * Owns: reading from the `transactions` table (created by Shared Services P1).
 * Does NOT own: Plaid sync, expense creation, budget tracking.
 *
 * Used by ClassificationService to load today's unclassified transactions.
 */

const db = require('../db/transactions');

const TransactionService = {
  /**
   * Get unclassified transactions for a user on a given date.
   * "Unclassified" means not yet in transaction_classifications.
   * Sorted by amount desc so biggest transactions appear first.
   * @param {object} pool
   * @param {number} userId
   * @param {string} date  - YYYY-MM-DD
   * @returns {Promise<object[]>}
   */
  async get_unclassified_transactions(pool, userId, date) {
    return db.getUnclassifiedByDate(pool, userId, date);
  },

  /**
   * Get a single transaction by ID, scoped to user.
   * @param {object} pool
   * @param {string} transactionId  - UUID
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async get_transaction(pool, transactionId, userId) {
    return db.getById(pool, transactionId, userId);
  },

  /**
   * Get a single transaction with its classification (if any).
   * @param {object} pool
   * @param {string} transactionId  - UUID
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async get_transaction_with_classification(pool, transactionId, userId) {
    return db.getTransactionWithClassification(pool, transactionId, userId);
  },

  /**
   * Update or insert a classification for a transaction.
   * @param {object} pool
   * @param {string} transactionId  - UUID
   * @param {number} userId
   * @param {string} classification  - 'planned' | 'impulse'
   * @returns {Promise<object>}
   */
  async update_classification(pool, transactionId, userId, classification) {
    return db.updateClassification(pool, transactionId, userId, classification);
  },

  /**
   * Get all transactions (classified + unclassified) for a user on a date.
   * @param {object} pool
   * @param {number} userId
   * @param {string} date  - YYYY-MM-DD
   * @returns {Promise<object[]>}
   */
  async get_transactions_for_date(pool, userId, date) {
    return db.getByDate(pool, userId, date);
  },

  /**
   * Count unclassified transactions for a user on a given date.
   * Used to populate session.transaction_count on session start.
   * @param {object} pool
   * @param {number} userId
   * @param {string} date  - YYYY-MM-DD
   * @returns {Promise<number>}
   */
  async count_unclassified(pool, userId, date) {
    return db.countUnclassified(pool, userId, date);
  },

  /**
   * Upsert a transaction (idempotent by plaid_transaction_id).
   * Called by Plaid sync in P2; idempotent so safe to re-run.
   * @param {object} pool
   * @param {object} params
   * @returns {Promise<object>}
   */
  async upsert_transaction(pool, params) {
    return db.upsertTransaction(pool, params);
  },
};

module.exports = { TransactionService };