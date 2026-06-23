'use strict';
/**
 * Ensure plaid_accounts has all columns that upsertPlaidAccount INSERT requires.
 *
 * Root cause: Prisma created plaid_accounts before migration 1780925000000 ran,
 * so CREATE TABLE IF NOT EXISTS was a no-op and any columns Prisma omitted are
 * still missing. upsertPlaidAccount explicitly names user_id, official_name,
 * type, subtype, mask in its INSERT — a missing column throws a Postgres error
 * that the catch block swallows, returning null. The account never enters
 * plaid_accounts, getAccountMap can't find it, and all transactions for that
 * account are dropped as "unknown account IDs".
 *
 * Core migrate.js also adds these unconditionally on every boot, but this
 * migration creates a permanent tracked record.
 */
module.exports = {
  name: 'ensure_plaid_accounts_user_id',

  up: async (client) => {
    const patches = [
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS user_id       INT`,
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS official_name VARCHAR(255)`,
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS type          VARCHAR(50)`,
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS subtype       VARCHAR(50)`,
      `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS mask          VARCHAR(10)`,
    ];
    for (const sql of patches) {
      try { await client.query(sql); } catch (e) {
        console.warn('[migration] ensure_plaid_accounts_user_id patch skipped:', e.message);
      }
    }
    // Backfill user_id from plaid_items for rows inserted before this column existed
    await client.query(
      `UPDATE plaid_accounts pa
       SET user_id = pi.user_id
       FROM plaid_items pi
       WHERE pa.plaid_item_id = pi.id
         AND pa.user_id IS NULL`
    );
  },

  down: async (_client) => {
    // Columns left in place — removing them would break upsertPlaidAccount
  },
};
