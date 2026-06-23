'use strict';
/**
 * Replace the PARTIAL unique index on plaid_transactions.transaction_id with a
 * full (non-partial) unique index.
 *
 * Root cause: migration 1782500000000 created a PARTIAL index:
 *   CREATE UNIQUE INDEX plaid_txs_transaction_id_unique
 *     ON plaid_transactions (transaction_id)
 *     WHERE transaction_id IS NOT NULL
 *
 * PostgreSQL requires that ON CONFLICT (col) inference matches the index
 * predicate exactly. A partial index with "WHERE transaction_id IS NOT NULL"
 * cannot be used by "ON CONFLICT (transaction_id)" (without matching WHERE).
 * Every insertPlaidTransaction() call therefore threw:
 *   "there is no unique constraint matching given keys for referenced table"
 * That exception was caught silently → null returned → 0 transactions ever
 * written to plaid_transactions → money tab stays empty.
 *
 * Fix: drop the partial index; create a full unique index.
 * PostgreSQL UNIQUE indexes already allow multiple NULLs (NULL ≠ NULL), so
 * no WHERE guard is needed to accommodate nullable transaction_id rows.
 */
module.exports = {
  name: 'fix_plaid_txs_full_unique_index',

  up: async (client) => {
    // Remove any duplicates that snuck in before the partial index existed.
    await client.query(`
      DELETE FROM plaid_transactions a
      USING plaid_transactions b
      WHERE a.transaction_id IS NOT NULL
        AND a.transaction_id = b.transaction_id
        AND a.id < b.id
    `);

    // Drop the partial index so the new full index can use the same name.
    await client.query(`DROP INDEX IF EXISTS plaid_txs_transaction_id_unique`);

    // Full unique index — works with ON CONFLICT (transaction_id) without WHERE.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS plaid_txs_transaction_id_unique
        ON plaid_transactions (transaction_id)
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS plaid_txs_transaction_id_unique`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS plaid_txs_transaction_id_unique
        ON plaid_transactions (transaction_id)
        WHERE transaction_id IS NOT NULL
    `);
  },
};
