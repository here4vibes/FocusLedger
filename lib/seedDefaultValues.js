'use strict';

const DEFAULT_VALUES = [
  'Health & Wellbeing',
  'Family & Relationships',
  'Career & Growth',
  'Financial Security',
  'Personal Freedom',
];

/**
 * Insert default personal values for a new user if they have none yet.
 * Fire-and-forget — errors are logged but not thrown.
 */
async function seedDefaultValues(pool, userId) {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM user_values WHERE user_id = $1',
      [userId]
    );
    if (parseInt(rows[0].cnt, 10) > 0) return;
    for (const name of DEFAULT_VALUES) {
      await pool.query(
        'INSERT INTO user_values (user_id, value_name) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, name]
      );
    }
  } catch (err) {
    console.error('[seedDefaultValues] error for user', userId, err.message);
  }
}

module.exports = { seedDefaultValues };
