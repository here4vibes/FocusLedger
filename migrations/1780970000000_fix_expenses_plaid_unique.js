'use strict';
/**
 * Ensure expenses.plaid_transaction_id has a UNIQUE index.
 *
 * The original migration (add_missing_money_columns) used:
 *   ADD COLUMN IF NOT EXISTS plaid_transaction_id VARCHAR(255) UNIQUE
 * If the column already existed without a constraint, ADD COLUMN IF NOT EXISTS
 * skips the entire statement — including the UNIQUE part. This left the column
 * without a unique index, causing every ON CONFLICT (plaid_transaction_id) call
 * to throw a silent error and Import All to silently confirm 0 transactions.
 *
 * Fix: deduplicate any existing rows, then CREATE UNIQUE INDEX IF NOT EXISTS.
 */
module.exports = {
  name: 'fix_expenses_plaid_unique_constraint',

  up: async (client) => {
    // Ensure column exists in case a very old schema is missing it
    await client.query(`
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS plaid_transaction_id VARCHAR(255)
    `);

    // Remove any duplicate plaid_transaction_id rows, keeping the highest id
    await client.query(`
      DELETE FROM expenses a
      USING expenses b
      WHERE a.plaid_transaction_id IS NOT NULL
        AND a.plaid_transaction_id = b.plaid_transaction_id
        AND a.id < b.id
    `);

    // Create unique index (IF NOT EXISTS — safe to re-run)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS expenses_plaid_tx_id_unique
        ON expenses (plaid_transaction_id)
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS expenses_plaid_tx_id_unique`);
  },
};
