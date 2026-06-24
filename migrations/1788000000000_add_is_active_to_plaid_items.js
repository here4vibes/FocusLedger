'use strict';
module.exports = {
  name: 'add_is_active_to_plaid_items',

  up: async (client) => {
    await client.query(`
      ALTER TABLE plaid_items
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true
    `);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE plaid_items DROP COLUMN IF EXISTS is_active
    `);
  },
};
