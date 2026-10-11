'use strict';
/**
 * tasks.description: JSON -> TEXT.
 *
 * Production's column is JSON (from the Prisma era), but every writer stores
 * plain text: task notes (routes/tasks-prisma.js), email-to-tasks, recurring
 * tasks, and bill reminders. Plain text isn't valid JSON, so each of those
 * inserts failed. In Oct 2026 not a single task had a description, and the
 * old auto-bill feature had never created one task. Readers already treat it
 * as a string. Idempotent; a JSON string value becomes its text, anything
 * else its JSON text.
 */
module.exports = {
  name: 'tasks_description_text',

  up: async (client) => {
    const { rows } = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'description'`);
    if (!rows[0] || rows[0].data_type === 'text') return;
    await client.query(`
      ALTER TABLE tasks ALTER COLUMN description TYPE TEXT
      USING CASE
        WHEN description IS NULL THEN NULL
        WHEN json_typeof(description::json) = 'string' THEN description::json #>> '{}'
        ELSE description::text
      END`);
  },

  down: async () => {
    // Not reverted: going back to JSON would break every text writer again.
  },
};
