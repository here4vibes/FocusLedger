'use strict';
/**
 * Ensure plaid_accounts has balance + balance_updated_at columns.
 *
 * add_balance_to_plaid_accounts (1780975000000) contains the same DDL
 * but evidence shows it hasn't run in production — the exchange-token
 * route throws "column current_balance does not exist" on every Reconnect.
 *
 * This migration uses a fresh name (not in _migrations) and ADD COLUMN
 * IF NOT EXISTS so it is safe to run even if the columns somehow exist.
 */
module.exports = {
  name: 'ensure_plaid_accounts_balance_cols',

  up: async (client) => {
    await client.query(`
      ALTER TABLE plaid_accounts
        ADD COLUMN IF NOT EXISTS current_balance    NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS available_balance  NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE plaid_accounts
        DROP COLUMN IF EXISTS current_balance,
        DROP COLUMN IF EXISTS available_balance,
        DROP COLUMN IF EXISTS balance_updated_at
    `);
  },
};
