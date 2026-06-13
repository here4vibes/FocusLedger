'use strict';
/**
 * Fix two column type mismatches in the expenses table introduced by the
 * original Prisma-managed schema vs the later SQL migrations:
 *
 * 1. expenses.plaid_transaction_id is INTEGER in production but must be
 *    VARCHAR(255). Plaid transaction IDs are strings like "yVGobRKbBwI...".
 *    Inserting a string into an integer column throws:
 *      "invalid input syntax for type integer: <plaid_id>"
 *    This silently killed every Import All / sync operation.
 *
 * 2. expenses.amount is INTEGER in production but must be NUMERIC(12,2).
 *    Decimal amounts like 25.50 are stored as 26 (rounded). Minor precision
 *    loss, but wrong type for financial data.
 *
 * Both changes use USING clauses so existing data is preserved:
 *   - integer plaid_transaction_ids (if any) become their decimal string form
 *   - integer amounts stay numerically identical but gain decimal precision
 */
module.exports = {
  name: 'fix_expenses_column_types',

  up: async (client) => {
    // 1. plaid_transaction_id: INTEGER → VARCHAR(255)
    //    Guard: only alter if the column is currently integer-typed.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expenses'
            AND column_name = 'plaid_transaction_id'
            AND data_type = 'integer'
        ) THEN
          ALTER TABLE expenses
            ALTER COLUMN plaid_transaction_id TYPE VARCHAR(255)
            USING plaid_transaction_id::TEXT;
        END IF;
      END $$
    `);

    // 2. amount: INTEGER → NUMERIC(12,2)
    //    Guard: only alter if the column is currently integer-typed.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'expenses'
            AND column_name = 'amount'
            AND data_type = 'integer'
        ) THEN
          ALTER TABLE expenses
            ALTER COLUMN amount TYPE NUMERIC(12,2)
            USING amount::NUMERIC(12,2);
        END IF;
      END $$
    `);

    // 3. Ensure the unique index on plaid_transaction_id exists (varchar now)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS expenses_plaid_tx_id_unique
        ON expenses (plaid_transaction_id)
        WHERE plaid_transaction_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS expenses_plaid_tx_id_unique`);
    // Note: reversing these type changes would lose precision; down() is
    // provided for bookkeeping only — do not run in production.
    await client.query(`
      ALTER TABLE expenses ALTER COLUMN plaid_transaction_id TYPE INTEGER
        USING plaid_transaction_id::INTEGER
    `);
    await client.query(`
      ALTER TABLE expenses ALTER COLUMN amount TYPE INTEGER
        USING amount::INTEGER
    `);
  },
};
