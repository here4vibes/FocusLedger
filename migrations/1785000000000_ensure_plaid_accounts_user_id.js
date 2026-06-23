'use strict';
/**
 * Ensure plaid_accounts.user_id column exists.
 *
 * Root cause: Prisma may have created plaid_accounts without the user_id column
 * (if it ran before migration 1780925000000 added it to the schema). When user_id
 * is missing, every upsertPlaidAccount INSERT fails silently — causing ALL Plaid
 * transactions to be skipped with "unknown account IDs" during sync, even though
 * the account_id is valid and plaid_items is correct.
 *
 * Core migrate.js also adds this column unconditionally on every boot, but this
 * migration creates a permanent tracked record that it ran.
 */
module.exports = {
  name: 'ensure_plaid_accounts_user_id',

  up: async (client) => {
    await client.query(
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS user_id INT`
    );
    // Backfill from plaid_items for rows inserted before this column existed
    await client.query(
      `UPDATE plaid_accounts pa
       SET user_id = pi.user_id
       FROM plaid_items pi
       WHERE pa.plaid_item_id = pi.id
         AND pa.user_id IS NULL`
    );
  },

  down: async (client) => {
    // Cannot safely DROP NOT NULL column — downgrade just removes the backfill effect
    // by leaving the column in place (removing it would break other code).
  },
};
