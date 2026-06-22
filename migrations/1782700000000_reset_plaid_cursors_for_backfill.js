'use strict';
/**
 * Reset all plaid_items cursors to NULL so the next sync re-fetches the full
 * transaction history from scratch.
 *
 * Background: after the UNIQUE constraint on plaid_transactions.transaction_id
 * was missing, every ON CONFLICT (transaction_id) DO NOTHING threw an error that
 * was silently swallowed — but the cursor still advanced, so Plaid believed all
 * transactions had been delivered. The constraint is now fixed, but cursors are
 * already positioned past the historical window.
 *
 * Safe to run: plaid_transactions deduplicates on transaction_id (UNIQUE index
 * added by fix_plaid_transactions_txid_unique), and expenses deduplicates on
 * plaid_transaction_id. Re-fetching will insert missing rows and skip rows that
 * were already inserted correctly.
 */
module.exports = {
  name: 'reset_plaid_cursors_for_backfill',

  up: async (client) => {
    await client.query(`UPDATE plaid_items SET cursor = NULL WHERE cursor IS NOT NULL`);
  },

  down: async (client) => {
    // Cursors cannot be restored — down is a no-op (next sync will advance them again).
  },
};
