'use strict';
/**
 * Text columns used as booleans, and a column the code writes but prod lacks.
 *
 * - insight_unlocks.viewed / interacted are TEXT in prod. The code writes true,
 *   which is stored as 'true'/'false', and GET /api/v1/insights/unlocks returns
 *   the string, so the client sees 'false' as truthy and treats every insight
 *   as already viewed.
 * - feature_suggestions.reward_applied / reward_notified are TEXT; the ideas
 *   PATCH checks `!idea.reward_applied`, which is false for the string 'false'.
 *   0 rows in prod.
 * - spending_sessions.updated_at doesn't exist, but db/spendingSessions.js sets
 *   it on every save and on complete, so both queries failed.
 * Idempotent: each conversion runs only while the column is still text.
 */
const TEXT_BOOLEANS = [
  ['insight_unlocks', 'viewed'],
  ['insight_unlocks', 'interacted'],
  ['feature_suggestions', 'reward_applied'],
  ['feature_suggestions', 'reward_notified'],
];

async function columnType(client, table, column) {
  const r = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows[0] ? r.rows[0].data_type : null;
}

module.exports = {
  name: 'text_booleans',

  up: async (client) => {
    for (const [table, column] of TEXT_BOOLEANS) {
      const type = await columnType(client, table, column);
      if (type !== 'text' && type !== 'character varying') continue;
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
      await client.query(`
        ALTER TABLE ${table} ALTER COLUMN ${column} TYPE boolean
        USING CASE WHEN ${column} IS NULL THEN NULL
                   ELSE lower(trim(${column})) IN ('true', 't', '1', 'yes') END`);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT false`);
    }

    if ((await columnType(client, 'spending_sessions', 'id')) && !(await columnType(client, 'spending_sessions', 'updated_at'))) {
      await client.query(`ALTER TABLE spending_sessions ADD COLUMN updated_at timestamptz DEFAULT now()`);
    }
  },
};
