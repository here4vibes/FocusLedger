'use strict';
/**
 * Enforce one app_subscription row per Stripe checkout session and per Stripe
 * subscription.
 *
 * Why: activation runs from two places at once after every purchase — the
 * Stripe webhook and the browser's post-checkout redirect. Both check
 * "already recorded?" then write; without a UNIQUE constraint they can both
 * pass the check and double-insert. Code comments claimed this index existed,
 * but migration 1780925000000 declared it inside CREATE TABLE IF NOT EXISTS on
 * a table genesis had already created, so it never landed on prod.
 *
 * Partial indexes: legacy/free rows have NULL ids, which must not collide.
 * Not CONCURRENTLY: the table is tiny, and migrate.js wraps each migration in
 * a transaction (CONCURRENTLY can't run inside one).
 *
 * If duplicates already exist this fails loudly instead of deleting rows —
 * these may be payment records and need a human to look.
 */
async function assertNoDuplicates(client, column) {
  const { rows } = await client.query(`
    SELECT ${column} AS v, COUNT(*)::int AS n
    FROM app_subscription
    WHERE ${column} IS NOT NULL
    GROUP BY ${column} HAVING COUNT(*) > 1
    LIMIT 5
  `);
  if (rows.length) {
    throw new Error(`app_subscription has duplicate ${column} values (${rows.map(r => `${r.v}×${r.n}`).join(', ')}) — resolve manually before adding the unique index`);
  }
}

module.exports = {
  name: 'app_subscription_unique_stripe_ids',

  up: async (client) => {
    await assertNoDuplicates(client, 'checkout_session_id');
    await assertNoDuplicates(client, 'stripe_subscription_id');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_subscription_checkout_session_id_uniq
      ON app_subscription (checkout_session_id) WHERE checkout_session_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_subscription_stripe_subscription_id_uniq
      ON app_subscription (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL
    `);
  },

  down: async (client) => {
    await client.query('DROP INDEX IF EXISTS app_subscription_checkout_session_id_uniq');
    await client.query('DROP INDEX IF EXISTS app_subscription_stripe_subscription_id_uniq');
  },
};
