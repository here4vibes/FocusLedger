'use strict';
/**
 * Repair tasks rows with NULL id values (Prisma artifact from pre-migration era).
 *
 * Prisma could insert rows without triggering the SERIAL DEFAULT, leaving id=NULL.
 * The earlier ensure_tasks_base_columns migration's ALTER TABLE ADD PRIMARY KEY
 * silently no-ops when NULL rows exist (PK constraint requires NOT NULL).
 *
 * Steps:
 * 1. Report how many null-ID tasks exist (logged to console for audit trail).
 * 2. Delete them — they are unreachable from the frontend (no id to toggle/edit).
 * 3. Ensure the id column has a NOT NULL constraint.
 * 4. Ensure the PRIMARY KEY constraint exists.
 * 5. Sync the sequence to max(id)+1 so future inserts don't collide.
 */
module.exports = {
  name: 'repair_null_id_tasks',

  up: async (client) => {
    // 1. Audit
    const { rows: nullRows } = await client.query(
      "SELECT user_id, title, created_at FROM tasks WHERE id IS NULL ORDER BY created_at"
    );
    if (nullRows.length > 0) {
      console.log(`[migration] found ${nullRows.length} null-ID task(s):`);
      nullRows.forEach(r => console.log(`  user_id=${r.user_id} title="${r.title}" created_at=${r.created_at}`));
    } else {
      console.log('[migration] no null-ID tasks found — constraint enforcement only');
    }

    // 2. Delete null-ID tasks (and their steps via cascade if FK exists, else explicit)
    await client.query("DELETE FROM task_steps WHERE task_id IS NULL");
    await client.query("DELETE FROM tasks WHERE id IS NULL");

    // 3. Add NOT NULL to id if missing
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET NOT NULL;
        END IF;
      END$$
    `);

    // 4. Add PRIMARY KEY if missing
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'tasks'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE tasks ADD PRIMARY KEY (id);
        END IF;
      END$$
    `);

    // 5. Set SERIAL DEFAULT if missing
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id'
            AND column_default LIKE 'nextval%'
        ) THEN
          CREATE SEQUENCE IF NOT EXISTS tasks_id_seq;
          ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq');
          PERFORM setval('tasks_id_seq', COALESCE((SELECT MAX(id) FROM tasks), 0) + 1, false);
        ELSE
          -- Sync existing sequence to current max to prevent future collisions
          PERFORM setval(
            pg_get_serial_sequence('tasks', 'id'),
            COALESCE((SELECT MAX(id) FROM tasks), 0) + 1,
            false
          );
        END IF;
      END$$
    `);
  },
};
