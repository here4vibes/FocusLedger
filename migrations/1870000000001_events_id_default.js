'use strict';
/**
 * events.id: give it a DEFAULT.
 *
 * The genesis schema has `id TEXT PRIMARY KEY` with no default (ids used to be
 * generated client-side by Prisma, since removed). db/events.insertEvent
 * inserts (user_id, event_type, payload) only, so on any database without a
 * default every insert fails with a NOT NULL violation — spending-session,
 * expense, Plaid-sync and evening check-in event logging included.
 * gen_random_uuid() is built in from Postgres 13.
 */
module.exports = {
  name: 'events_id_default',

  up: async (client) => {
    await client.query(`ALTER TABLE events ALTER COLUMN id SET DEFAULT gen_random_uuid()::text`);
  },

  down: async (client) => {
    await client.query(`ALTER TABLE events ALTER COLUMN id DROP DEFAULT`);
  },
};
