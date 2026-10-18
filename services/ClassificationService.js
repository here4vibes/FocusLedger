'use strict';
/**
 * services/ClassificationService.js — the spending check-in (planned vs impulse).
 *
 * Reviews the user's real bank charges: untriaged plaid_transactions and Plaid
 * expenses (queue defined in db/spendingSessions.js getCheckinQueue, the last
 * QUEUE_DAYS local days). A classification goes through the money tab's own db
 * functions, in one DB transaction:
 *   'pt:<id>'  → confirmTransaction (writes the expense, marks the bank row
 *                confirmed) → triageExpense (sets expenses.is_impulse)
 *   'exp:<id>' → triageExpense
 * so the money tab and the check-in always agree. expenses.is_impulse is the
 * record; the legacy transaction_classifications table is no longer written.
 * Session bookkeeping (spending_sessions) is keyed by the user's local date.
 *
 * Events: each classification inserts a 'transaction.classified' row in
 * `events` (payload.source = 'spending_checkin', session_id, expense_id) and
 * emits it on the EventBus; complete_session emits 'spending_session.complete'.
 */

const spendingDB = require('../db/spendingSessions');
const { confirmTransaction, triageExpense } = require('../db/money-prisma');
const { eventBus } = require('./EventBus');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

const VALID_CLASSIFICATIONS = new Set(['planned', 'impulse']);
const QUEUE_DAYS = 14;

class NotFoundError extends Error {}

/** YYYY-MM-DD minus n calendar days (pure date math, no clock). */
function minusDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** 'pt:12' → { kind: 'pt', id: 12 }; anything else → null. */
function parseItemId(raw) {
  const m = /^(pt|exp):(\d{1,10})$/.exec(String(raw || ''));
  if (!m) return null;
  const id = Number(m[2]);
  return id > 0 && id <= 2147483647 ? { kind: m[1], id } : null;
}

async function localToday(pool, userId) {
  return getUserLocalDate(await fetchUserTimezone(pool, userId));
}

function queueFor(pool, userId, today) {
  return spendingDB.getCheckinQueue(pool, userId, minusDays(today, QUEUE_DAYS - 1));
}

const ClassificationService = {
  QUEUE_DAYS,
  NotFoundError,

  /**
   * Classify one queue item. Re-classifying an answered item updates its
   * expense; no duplicate expense (confirm locks the bank row FOR UPDATE, and
   * expenses.plaid_transaction_id is unique).
   * @param {object} pool
   * @param {number} userId
   * @param {string} itemId          - 'pt:<id>' | 'exp:<id>'
   * @param {string} classification  - 'planned' | 'impulse'
   * @param {number} sessionId       - must be the user's session
   * @returns {Promise<object>} the triaged expense row
   * @throws {NotFoundError} unknown session or item (or a dismissed bank row)
   */
  async classify(pool, userId, itemId, classification, sessionId) {
    if (!VALID_CLASSIFICATIONS.has(classification)) {
      throw new Error(`Invalid classification: ${classification}. Must be 'planned' or 'impulse'.`);
    }
    const item = parseItemId(itemId);
    if (!item) throw new NotFoundError(`Transaction ${itemId} not found`);
    if (!(await spendingDB.getSessionById(pool, sessionId, userId))) {
      throw new NotFoundError(`Session ${sessionId} not found for user ${userId}`);
    }

    const client = await pool.connect();
    let expense = null;
    try {
      await client.query('BEGIN');
      if (!(await spendingDB.isCheckinEligible(client, item.kind, item.id, userId))) {
        throw new NotFoundError(`Transaction ${itemId} is not a reviewable bank charge for user ${userId}`);
      }
      let expenseId = item.kind === 'exp' ? item.id : null;
      if (item.kind === 'pt') {
        const confirmed = await confirmTransaction(client, item.id, userId);
        expenseId = confirmed
          ? confirmed.expenseId
          : await spendingDB.getConfirmedExpenseId(client, item.id, userId); // re-swipe
      }
      if (expenseId) {
        expense = await triageExpense(client, expenseId, userId, classification === 'impulse', null);
      }
      if (!expense) throw new NotFoundError(`Transaction ${itemId} not found for user ${userId}`);
      await spendingDB.insertEvent(client, 'transaction.classified', {
        source: 'spending_checkin',
        session_id: String(sessionId),
        item_id: itemId,
        expense_id: expense.id,
        classification,
      }, userId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(rbErr =>
        console.error('[ClassificationService] rollback failed:', rbErr.message, '| userId:', userId));
      throw err;
    } finally {
      client.release();
    }

    eventBus.emit('transaction.classified', {
      user_id: userId,
      transaction_id: itemId,
      expense_id: expense.id,
      classification,
      merchant_name: expense.description,
      amount: expense.amount, // NUMERIC dollars, as pg returns it (string)
      category: expense.category_name || null,
    });
    return expense;
  },

  /**
   * The user's session for `sessionDate` (their local date) and the current queue.
   * @returns {Promise<object|null>} null before the session is started
   */
  async get_session(pool, userId, sessionDate) {
    const session = await spendingDB.getSession(pool, userId, sessionDate);
    if (!session) return null;

    const [counts, transactions] = await Promise.all([
      spendingDB.getSessionCounts(pool, userId, session.id),
      queueFor(pool, userId, sessionDate),
    ]);

    return {
      session_id: session.id,
      date: session.session_date,
      // Answered items leave the queue, so the page needs no per-item list.
      classifications: [],
      impulse_count: counts.impulse_count,
      planned_count: counts.planned_count,
      complete: session.complete === true,
      transaction_count: transactions.length,
      transactions,
    };
  },

  /** Create or refresh today's session (user's local date) with the queue size. */
  async start_session(pool, userId) {
    const sessionDate = await localToday(pool, userId);
    const queue = await queueFor(pool, userId, sessionDate);
    const session = await spendingDB.upsertSession(pool, userId, sessionDate, queue.length);
    return {
      session_id: session.id,
      session_date: session.session_date,
      transaction_count: queue.length,
    };
  },

  /**
   * Mark the user's session complete; emits 'spending_session.complete'.
   * @throws {NotFoundError} when the session isn't the user's
   */
  async complete_session(pool, userId, sessionId) {
    const done = await spendingDB.completeSession(pool, sessionId, userId);
    if (!done) throw new NotFoundError(`Session ${sessionId} not found for user ${userId}`);
    const counts = await spendingDB.getSessionCounts(pool, userId, sessionId);
    eventBus.emit('spending_session.complete', {
      user_id: userId,
      session_id: sessionId,
      impulse_count: counts.impulse_count,
      planned_count: counts.planned_count,
      total_spend_cents: counts.total_spend_cents,
    });
  },

  /** Planned / impulse stats over classified expenses in a date range. */
  async get_stats(pool, userId, opts) {
    return spendingDB.getClassificationStats(pool, userId, opts.from, opts.to);
  },

  /** Top 3 impulse categories over the user's last 7 local days. */
  async get_recent_insights(pool, userId) {
    const today = await localToday(pool, userId);
    return spendingDB.getRecentInsights(pool, userId, minusDays(today, 6), 3);
  },

  localToday,
  minusDays,
};

module.exports = { ClassificationService };
