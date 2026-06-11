'use strict';
/**
 * Comprehensive tasks schema repair — runs even if repair_null_id_tasks already ran.
 *
 * 1. Ensures completed_at column exists (required by toggle UPDATE query).
 * 2. Deletes any remaining null-ID tasks (unreachable from UI; user-approved).
 * 3. Ensures tasks.id is NOT NULL with a SERIAL DEFAULT.
 * 4. Adds PRIMARY KEY constraint if still missing.
 * 5. Syncs the sequence to max(id)+1.
 */
module.exports = {
  name: 'fix_tasks_schema_v2',

  up: async (client) => {
    // 1. Add completed_at if missing — required by:
    //    UPDATE tasks SET is_completed=$1, completed_at=$2, updated_at=NOW() WHERE id=$3
    await client.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // 2. Audit and delete null-ID tasks
    const { rows: nullTasks } = await client.query(
      `SELECT user_id, title, created_at FROM tasks WHERE id IS NULL ORDER BY created_at`
    );
    if (nullTasks.length > 0) {
      console.log(`[fix_tasks_schema_v2] deleting ${nullTasks.length} null-ID task(s):`);
      nullTasks.forEach(r =>
        console.log(`  user_id=${r.user_id}  title="${r.title}"  created=${r.created_at}`)
      );
      await client.query(`DELETE FROM task_steps WHERE task_id IS NULL`);
      await client.query(`DELETE FROM tasks WHERE id IS NULL`);
    } else {
      console.log(`[fix_tasks_schema_v2] no null-ID tasks found`);
    }

    // 3. Ensure sequence exists and is synced
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq'
        ) THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
        PERFORM setval(
          'tasks_id_seq',
          COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1,
          false
        );
      END$$
    `);

    // 4. Enforce NOT NULL + DEFAULT on tasks.id
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id' AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET NOT NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tasks' AND column_name = 'id'
            AND column_default LIKE 'nextval%'
        ) THEN
          ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq');
        END IF;
      END$$
    `);

    // 5. Add PRIMARY KEY if missing
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

    console.log(`[fix_tasks_schema_v2] done`);
  },
};
