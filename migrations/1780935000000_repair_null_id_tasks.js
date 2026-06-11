'use strict';
/**
 * Repair tasks rows with NULL id values (Prisma artifact from pre-migration era).
 *
 * Prisma could insert rows without triggering the SERIAL DEFAULT, leaving id=NULL.
 * The earlier ensure_tasks_base_columns migration's ALTER TABLE ADD PRIMARY KEY
 * silently no-ops when NULL rows exist (PK constraint requires NOT NULL).
 *
 * These rows ARE real user tasks — they appear in the app via SELECT * but cannot
 * be completed, edited, or deleted because all operations require a numeric id.
 *
 * Steps:
 * 1. Ensure tasks_id_seq sequence exists and is synced to max(id).
 * 2. Assign real IDs to all null-id tasks via nextval().
 * 3. Repair orphaned task_steps rows that have null task_id.
 * 4. Enforce NOT NULL on tasks.id.
 * 5. Add PRIMARY KEY constraint if missing.
 */
module.exports = {
  name: 'repair_null_id_tasks',

  up: async (client) => {
    // 1. Ensure sequence exists and is ahead of current max id
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq') THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
      END$$
    `);
    // Sync sequence to be safely above the current max id
    await client.query(`
      SELECT setval(
        'tasks_id_seq',
        COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1,
        false
      )
    `);

    // 2. Audit and assign IDs to null-id tasks
    const { rows: nullTasks } = await client.query(
      "SELECT ctid, user_id, title, created_at FROM tasks WHERE id IS NULL ORDER BY created_at"
    );

    if (nullTasks.length === 0) {
      console.log('[migration repair_null_id_tasks] no null-ID tasks found');
    } else {
      console.log(`[migration repair_null_id_tasks] assigning IDs to ${nullTasks.length} task(s):`);
      nullTasks.forEach(r =>
        console.log(`  user_id=${r.user_id} title="${r.title}" created_at=${r.created_at}`)
      );

      // Assign a real id to each null-id row using the ctid (physical row pointer)
      // to address rows that have no other unique identifier
      await client.query(`
        UPDATE tasks
        SET id = nextval('tasks_id_seq')
        WHERE id IS NULL
      `);

      console.log(`[migration repair_null_id_tasks] assigned IDs to ${nullTasks.length} task(s) — tasks are now fully functional`);
    }

    // 3. Delete orphaned task_steps with null task_id (can't be linked to any task)
    const { rowCount: orphanSteps } = await client.query(
      "DELETE FROM task_steps WHERE task_id IS NULL"
    );
    if (orphanSteps > 0) {
      console.log(`[migration repair_null_id_tasks] removed ${orphanSteps} orphaned task_steps row(s)`);
    }

    // 4. Enforce NOT NULL on tasks.id
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET NOT NULL;
          RAISE NOTICE 'tasks.id: NOT NULL enforced';
        END IF;
      END$$
    `);

    // 5. Set DEFAULT nextval so future inserts always get an id
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id'
            AND column_default LIKE 'nextval%'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq');
          RAISE NOTICE 'tasks.id: DEFAULT nextval set';
        END IF;
      END$$
    `);

    // 6. Add PRIMARY KEY constraint if missing
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'tasks'::regclass AND contype = 'p'
        ) THEN
          ALTER TABLE tasks ADD PRIMARY KEY (id);
          RAISE NOTICE 'tasks: PRIMARY KEY added';
        END IF;
      END$$
    `);
  },
};
