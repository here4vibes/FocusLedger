'use strict';
/**
 * Add updated_at to the expenses table.
 *
 * The original expenses table was created before migrations and never got
 * updated_at. The triageExpense UPDATE runs `SET is_impulse = $1, updated_at = NOW()`
 * which throws "column does not exist", silently swallowed by the route catch,
 * causing all triage PATCH calls to return 500 without saving anything.
 */
module.exports = {
  name: 'add_updated_at_to_expenses',

  up: async (client) => {
    await client.query(`
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);
  },

  down: async (client) => {
    await client.query(`ALTER TABLE expenses DROP COLUMN IF EXISTS updated_at`);
  },
};
