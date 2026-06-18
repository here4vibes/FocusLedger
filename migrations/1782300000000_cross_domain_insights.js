module.exports = {
  name: 'cross_domain_insights',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS cross_domain_insights (
        id           SERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        week_start   DATE NOT NULL,
        insight_text TEXT NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_domain_insights_user_week
        ON cross_domain_insights (user_id, week_start)
    `);
  },
  down: async (client) => {
    await client.query(`DROP TABLE IF EXISTS cross_domain_insights`);
  },
};
