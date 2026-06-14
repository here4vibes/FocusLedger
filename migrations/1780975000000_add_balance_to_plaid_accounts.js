'use strict';
module.exports = {
  name: 'add_balance_to_plaid_accounts',
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
