// Verification script: test the task filter for morning check-in
// Run: node verify-task-filter.js

const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const userId = parseInt(process.argv[2]) || 1;

  // Simulate what the status endpoint does
  const today = new Date().toISOString().slice(0, 10);

  console.log('Today:', today);
  console.log('User ID:', userId);
  console.log('');

  // Count ALL incomplete tasks
  const allResult = await pool.query(
    'SELECT COUNT(*) as count, MIN(due_date) as earliest, MAX(due_date) as latest FROM tasks WHERE user_id = $1 AND is_completed = false',
    [userId]
  );
  console.log('ALL incomplete tasks:', allResult.rows[0].count);
  console.log('Earliest due_date:', allResult.rows[0].earliest);
  console.log('Latest due_date:', allResult.rows[0].latest);
  console.log('');

  // Count FILTERED tasks (the filter used in status endpoint)
  const filteredResult = await pool.query(`
    SELECT id, title, due_date
    FROM tasks
    WHERE user_id = $1
      AND is_completed = false
      AND (due_date IS NULL OR due_date <= $2::date + INTERVAL '3 days')
    ORDER BY due_date ASC NULLS LAST
    LIMIT 50
  `, [userId, today]);

  console.log('FILTERED tasks (due <= today+3 days or no due_date):', filteredResult.rows.length);
  console.log('Sample filtered tasks:');
  filteredResult.rows.forEach(t => {
    const dd = t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : 'NO DATE';
    const daysUntil = t.due_date
      ? Math.ceil((new Date(t.due_date) - new Date(today)) / (1000 * 60 * 60 * 24))
      : 'N/A (no date)';
    console.log(`  - [${dd}] ${daysUntil} day(s) from today: "${t.title}"`);
  });

  console.log('');

  // Show tasks that ARE in the DB but would be EXCLUDED by the filter
  const excludedResult = await pool.query(`
    SELECT id, title, due_date
    FROM tasks
    WHERE user_id = $1
      AND is_completed = false
      AND due_date > $2::date + INTERVAL '3 days'
    ORDER BY due_date ASC
    LIMIT 20
  `, [userId, today]);

  console.log('EXCLUDED tasks (due > today+3 days):', excludedResult.rows.length);
  if (excludedResult.rows.length > 0) {
    console.log('These would be hidden from morning check-in:');
    excludedResult.rows.forEach(t => {
      const daysUntil = Math.ceil((new Date(t.due_date) - new Date(today)) / (1000 * 60 * 60 * 24));
      console.log(`  - [${t.due_date}] +${daysUntil} days: "${t.title}"`);
    });
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});