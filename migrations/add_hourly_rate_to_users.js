module.exports = {
  name: 'add_hourly_rate_to_users',
  async up(client) {
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10, 2)
    `);
  },
  async down(client) {
    await client.query('ALTER TABLE users DROP COLUMN IF EXISTS hourly_rate');
  },
};
