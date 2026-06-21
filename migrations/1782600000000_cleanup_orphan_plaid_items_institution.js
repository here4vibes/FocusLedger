'use strict';
/**
 * Clean up orphan plaid_items rows that share the same (institution_id, user_id).
 *
 * Root cause: each Amex OAuth reconnect gives Plaid a brand-new item_id, so the
 * ON CONFLICT (item_id, user_id) in upsertPlaidItem never fires — every reconnect
 * appended a new row. Over time this produces multiple items for the same bank:
 *   - old items with stale/revoked access_tokens that return 0 transactions
 *   - duplicate plaid_accounts rows across items for the same physical card
 *   - syncTransactions calling Plaid with dead tokens and skipping 0 transactions
 *
 * Fix:
 *   1. For each (user_id, institution_id) group keep the highest-id item (most recent).
 *   2. Reassign orphan accounts to the survivor (skip if account_id already on survivor).
 *   3. Delete orphan items (CASCADE removes any remaining orphan-only accounts).
 *   4. Add UNIQUE INDEX on (institution_id, user_id) — upsertPlaidItem updated to use it.
 */
module.exports = {
  name: 'cleanup_orphan_plaid_items_institution',

  up: async (client) => {
    // 1. Reassign orphan accounts to the most-recent survivor item
    await client.query(`
      WITH survivors AS (
        SELECT DISTINCT ON (user_id, institution_id)
          id AS survivor_id, user_id, institution_id
        FROM plaid_items
        WHERE institution_id IS NOT NULL
        ORDER BY user_id, institution_id, id DESC
      ),
      orphan_map AS (
        SELECT p.id AS orphan_id, s.survivor_id
        FROM plaid_items p
        JOIN survivors s
          ON s.user_id = p.user_id
         AND s.institution_id = p.institution_id
        WHERE p.id != s.survivor_id
      )
      UPDATE plaid_accounts pa
      SET plaid_item_id = om.survivor_id
      FROM orphan_map om
      WHERE pa.plaid_item_id = om.orphan_id
        AND NOT EXISTS (
          SELECT 1 FROM plaid_accounts pa2
          WHERE pa2.plaid_item_id = om.survivor_id
            AND pa2.account_id   = pa.account_id
        )
    `);

    // 2. Delete orphan items (CASCADE removes any accounts still pointing to them)
    await client.query(`
      DELETE FROM plaid_items
      WHERE institution_id IS NOT NULL
        AND id NOT IN (
          SELECT DISTINCT ON (user_id, institution_id) id
          FROM plaid_items
          WHERE institution_id IS NOT NULL
          ORDER BY user_id, institution_id, id DESC
        )
    `);

    // 3. Add unique index so future reconnects upsert rather than insert
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS plaid_items_institution_user_unique
        ON plaid_items (institution_id, user_id)
        WHERE institution_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS plaid_items_institution_user_unique`);
    // Orphan rows cannot be restored — down is a schema-only rollback.
  },
};
