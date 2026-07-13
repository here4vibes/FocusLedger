'use strict';
/**
 * budgets — weekly spending budget per user (Money tab).
 *
 * Referenced by routes/auth.js (seeded $500 default on signup) and
 * routes/expenses.js (read/update), but NO migration ever created it —
 * Prisma-era drift. In production this INSERT threw on every EMAIL signup,
 * failing the whole request AFTER the users row was created (Google OAuth
 * signup swallowed the error with .catch(), which is why only email signup
 * broke). It also silently broke the Money-tab weekly budget feature.
 */
module.exports = {
  name: 'create_budgets',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        weekly_amount NUMERIC(12,2) NOT NULL DEFAULT 500.00,
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // One active budget per user (the read path uses LIMIT 1; keep it clean)
    await client.query(`
      CREATE INDEX IF NOT EXISTS budgets_user_active_idx ON budgets (user_id, is_active)
    `);
  },

  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS budgets`);
  },
};
