'use strict';
/**
 * ai_usage_daily: per-user AI calls and tokens per UTC day (lib/ai-budget.js).
 * Backs the daily AI limit and gives visibility into model cost per user.
 */
module.exports = {
  name: 'ai_usage_daily',

  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_usage_daily (
        user_id INTEGER NOT NULL,
        usage_date DATE NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, usage_date)
      )`);
  },

  down: async (client) => {
    await client.query('DROP TABLE IF EXISTS ai_usage_daily');
  },
};
