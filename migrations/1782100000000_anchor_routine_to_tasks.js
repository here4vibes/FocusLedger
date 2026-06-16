'use strict';
/**
 * Add anchor_routine_id + anchor_label to tasks.
 * anchor_routine_id: FK to routines — "do this task after [routine] completes"
 * anchor_label: optional custom cue text (e.g. "After morning coffee")
 * ON DELETE SET NULL so deleting a routine never orphans the task.
 */
module.exports = {
  name: 'anchor_routine_to_tasks',
  up: async (client) => {
    await client.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS anchor_routine_id INT REFERENCES routines(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS anchor_label TEXT
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_anchor_routine
        ON tasks(anchor_routine_id)
        WHERE anchor_routine_id IS NOT NULL
    `);
  },
  down: async (client) => {
    await client.query(`DROP INDEX IF EXISTS idx_tasks_anchor_routine`);
    await client.query(`
      ALTER TABLE tasks
        DROP COLUMN IF EXISTS anchor_routine_id,
        DROP COLUMN IF EXISTS anchor_label
    `);
  },
};
