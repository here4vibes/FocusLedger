'use strict';
/**
 * Deduplicate plaid_items rows that share the same (item_id, user_id).
 *
 * Root cause: upsertPlaidItem did a plain INSERT on every connect attempt,
 * so failed connects (e.g. when balance columns were missing) left orphan rows.
 * These orphan rows have no plaid_accounts children and caused:
 *   - loadAccountCard() to pick the orphan as firstItem → no accounts → balance "—"
 *   - /api/plaid/balances to loop over a stale/invalid access_token
 *
 * Strategy:
 *   1. For each duplicate group, keep the row with the highest id (most recent).
 *   2. Delete the older duplicates.
 *   3. Add UNIQUE INDEX (item_id, user_id) so upsertPlaidItem can use ON CONFLICT.
 */
module.exports = {
  name: 'deduplicate_plaid_items',

  up: async (client) => {
    // 1. Delete orphan duplicates — keep the highest id per (item_id, user_id)
    await client.query(`
      DELETE FROM plaid_items a
      USING plaid_items b
      WHERE a.item_id  IS NOT NULL
        AND a.item_id  = b.item_id
        AND a.user_id  = b.user_id
        AND a.id < b.id
    `);

    // 2. Add unique index so future reconnects upsert rather than insert
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS plaid_items_item_id_user_id_unique
        ON plaid_items (item_id, user_id)
        WHERE item_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS plaid_items_item_id_user_id_unique`);
  },
};
