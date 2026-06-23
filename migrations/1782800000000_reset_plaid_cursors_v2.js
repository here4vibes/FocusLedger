'use strict';
/**
 * Second cursor reset: the first reset (_v1) ran before the UNIQUE index on
 * plaid_transactions.transaction_id existed. The 6am cron's ON CONFLICT threw
 * on every row (no constraint), so zero transactions were inserted — but the
 * cursor still advanced to the end of Plaid history.
 *
 * Safe to re-run: expenses dedup on plaid_transaction_id, plaid_transactions
 * deduplicates on the UNIQUE index (now in place since PR #115).
 */
module.exports = {
  name: 'reset_plaid_cursors_v2',

  up: async (client) => {
    await client.query(`UPDATE plaid_items SET cursor = NULL WHERE cursor IS NOT NULL`);
  },

  down: async (_client) => {
    // Cursors cannot be restored — next sync will advance them again.
  },
};
