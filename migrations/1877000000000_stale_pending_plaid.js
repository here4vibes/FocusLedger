'use strict';
/**
 * One-time cleanup: pending bank transactions that were never removed.
 *
 * When a pending charge posts, Plaid reports the pending one as removed, and
 * jobs/plaid-sync.js deletes it only `WHERE is_confirmed = false`. That column
 * had no default (fixed in missing_defaults), so it was NULL and nothing was
 * ever deleted. The stale pending rows double-count in totals that include
 * pending charges.
 *
 * A pending charge more than 14 days old is never still outstanding. It either
 * posted, often with a different amount or name (tips, hotel and rental
 * holds), or was dropped (e.g. $1 card checks). Previewed on prod on
 * 2026-10-18: 217 rows, one user, 2026-06-20 to 2026-10-03; 191 have an exact
 * posted twin, and the other 26 are holds or card checks. No foreign keys
 * reference plaid_transactions, and none of these rows has an expense.
 * Deletion approved by the user on 2026-10-18.
 */
module.exports = {
  name: 'stale_pending_plaid',

  up: async (client) => {
    const r = await client.query(`
      DELETE FROM plaid_transactions
      WHERE is_pending IS TRUE
        AND is_confirmed IS NOT TRUE
        AND expense_id IS NULL
        AND transaction_date < CURRENT_DATE - 14`);
    console.log(`[migration stale_pending_plaid] deleted ${r.rowCount} stale pending transactions`);
  },
};
