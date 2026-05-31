'use strict';

/**
 * Add an email to the iOS waitlist.
 * @returns {{ alreadyExists: boolean }}
 */
async function addToWaitlist(pool, email, source = 'ios_waitlist') {
  const { rows: existing } = await pool.query(
    'SELECT id FROM ios_waitlist WHERE email = $1 LIMIT 1',
    [email.toLowerCase().trim()]
  );
  if (existing.length) return { alreadyExists: true };

  await pool.query(
    'INSERT INTO ios_waitlist (email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [email.toLowerCase().trim(), source]
  );
  return { alreadyExists: false };
}

module.exports = { addToWaitlist };
