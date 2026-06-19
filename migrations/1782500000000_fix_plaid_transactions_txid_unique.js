'use strict';
/**
 * Ensure plaid_transactions.transaction_id has a UNIQUE index.
 *
 * The original CREATE TABLE included `transaction_id VARCHAR(255) NOT NULL UNIQUE`,
 * but CREATE TABLE IF NOT EXISTS is a no-op when the table already existed —
 * leaving the column without a unique constraint. This caused every
 * `ON CONFLICT (transaction_id) DO NOTHING` to throw:
 *   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
 * That error was silently caught and returned null, so no transactions were
 * ever inserted into plaid_transactions and the money tab stayed empty even
 * after a successful Plaid bank link.
 *
 * Fix: deduplicate any existing rows, then add the unique index.
 */
module.exports = {
  name: 'fix_plaid_transactions_txid_unique',

  up: async (client) => {
    // Remove duplicate transaction_id rows, keeping the highest id (most recent)
    await client.query(`
      DELETE FROM plaid_transactions a
      USING plaid_transactions b
      WHERE a.transaction_id IS NOT NULL
        AND a.transaction_id = b.transaction_id
        AND a.id < b.id
    `);

    // Add unique index (IF NOT EXISTS — safe to re-run even if constraint already present)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS plaid_txs_transaction_id_unique
        ON plaid_transactions (transaction_id)
        WHERE transaction_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS plaid_txs_transaction_id_unique`);
  },
};
