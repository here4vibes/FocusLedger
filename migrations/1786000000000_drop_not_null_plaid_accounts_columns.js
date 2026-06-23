'use strict';
/**
 * Drop NOT NULL constraints on plaid_accounts columns that Prisma created as non-nullable.
 *
 * Root cause: ghost account rows (created by syncTransactions when a transaction
 * references an account_id that no longer appears in accountsGet or syncAccounts —
 * common after Amex OAuth reconnects) pass NULL for type, subtype, official_name, mask.
 * If those columns are NOT NULL (Prisma default for non-optional fields), the INSERT
 * fails silently and every transaction for the remapped account is dropped.
 *
 * Each ALTER is wrapped in its own try/catch because DROP NOT NULL on an already-
 * nullable column is an error ("column does not have a not-null constraint").
 */
module.exports = {
  name: 'drop_not_null_plaid_accounts_columns',

  up: async (client) => {
    const patches = [
      `ALTER TABLE plaid_accounts ALTER COLUMN type          DROP NOT NULL`,
      `ALTER TABLE plaid_accounts ALTER COLUMN subtype       DROP NOT NULL`,
      `ALTER TABLE plaid_accounts ALTER COLUMN name          DROP NOT NULL`,
      `ALTER TABLE plaid_accounts ALTER COLUMN official_name DROP NOT NULL`,
      `ALTER TABLE plaid_accounts ALTER COLUMN mask          DROP NOT NULL`,
    ];
    for (const sql of patches) {
      try { await client.query(sql); } catch (e) {
        console.warn('[migration] drop_not_null_plaid_accounts_columns skipped:', e.message);
      }
    }
  },

  down: async (_client) => {
    // NOT NULL constraints intentionally not restored — restoring them would
    // break ghost account creation again.
  },
};
