'use strict';

module.exports = {
  name: 'add_icon_color_to_categories',
  up: async (client) => {
    // Add columns if they don't already exist (safe to re-run)
    await client.query(`
      ALTER TABLE categories
        ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT '#6B6B80',
        ADD COLUMN IF NOT EXISTS icon  VARCHAR(10) NOT NULL DEFAULT ''
    `);

    // Backfill icons + colors for the 10 standard categories
    const rows = [
      { name: 'Housing',        color: '#4A9292', icon: '🏠' },
      { name: 'Bills',          color: '#5B7FA4', icon: '📄' },
      { name: 'Groceries',      color: '#4A8C5C', icon: '🛒' },
      { name: 'Food & Delivery',color: '#C4763A', icon: '🍕' },
      { name: 'Subscriptions',  color: '#7A5BAD', icon: '🔄' },
      { name: 'Shopping',       color: '#AD5B8C', icon: '🛍️' },
      { name: 'Transport',      color: '#4A6BAD', icon: '🚗' },
      { name: 'Health',         color: '#5BAD7A', icon: '🏥' },
      { name: 'Fun',            color: '#AD7A4A', icon: '🎮' },
      { name: 'Other',          color: '#6B6B80', icon: '📦' },
    ];

    for (const row of rows) {
      await client.query(
        `UPDATE categories SET color = $1, icon = $2 WHERE LOWER(name) = LOWER($3) AND (icon = '' OR icon IS NULL)`,
        [row.color, row.icon, row.name]
      );
    }

    // Seed the categories if the table is still empty after all of the above
    await client.query(`
      INSERT INTO categories (name, color, icon)
      SELECT unnest(ARRAY['Housing','Bills','Groceries','Food & Delivery','Subscriptions','Shopping','Transport','Health','Fun','Other']),
             unnest(ARRAY['#4A9292','#5B7FA4','#4A8C5C','#C4763A','#7A5BAD','#AD5B8C','#4A6BAD','#5BAD7A','#AD7A4A','#6B6B80']),
             unnest(ARRAY['🏠','📄','🛒','🍕','🔄','🛍️','🚗','🏥','🎮','📦'])
      WHERE NOT EXISTS (SELECT 1 FROM categories LIMIT 1)
    `);
  },
};
