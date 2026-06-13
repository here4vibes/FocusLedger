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
 * Strategy: drop the unique index before altering column types so PostgreSQL
 * does not need to rebuild it in place (avoids edge cases with typed indexes).
 * We then deduplicate and recreate the index explicitly.
 */
module.exports = {
  name: 'fix_expenses_column_types',

  up: async (client) => {
    // Drop the unique index first so ALTER COLUMN TYPE has no index to rebuild.
    await client.query(`DROP INDEX IF EXISTS expenses_plaid_tx_id_unique`);

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

    // 3. Deduplicate before recreating the unique index (keeps highest id per tx)
    await client.query(`
      DELETE FROM expenses a
      USING expenses b
      WHERE a.plaid_transaction_id IS NOT NULL
        AND a.plaid_transaction_id = b.plaid_transaction_id
        AND a.id < b.id
    `);

    // 4. Recreate unique index (partial — excludes NULLs for manual expenses)
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
