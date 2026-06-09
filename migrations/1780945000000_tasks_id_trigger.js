'use strict';
/**
 * Belt-and-suspenders fix for tasks.id assignment.
 *
 * Problem: tasks.id has no column DEFAULT linked to a sequence, so every
 * INSERT (from any route — buddy, journal, email, manual) returns id=NULL.
 * The column DEFAULT alone is fragile; a BEFORE INSERT trigger is not.
 *
 * This migration:
 * 1. Ensures tasks_id_seq exists and is synced to max(id)+1.
 * 2. Unconditionally sets the column DEFAULT to nextval('tasks_id_seq').
 * 3. Makes the sequence OWNED BY tasks.id (links lifecycle).
 * 4. Installs a BEFORE INSERT trigger that assigns id if still NULL after DEFAULT.
 * 5. Deletes any remaining null-ID tasks.
 * 6. Enforces NOT NULL + PRIMARY KEY.
 */
module.exports = {
  name: 'tasks_id_trigger',

  up: async (client) => {
    // 1. Ensure sequence exists
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'tasks_id_seq') THEN
          CREATE SEQUENCE tasks_id_seq;
        END IF;
      END$$
    `);

    // Sync sequence to safely above current max id
    await client.query(`
      SELECT setval(
        'tasks_id_seq',
        COALESCE((SELECT MAX(id) FROM tasks WHERE id IS NOT NULL), 0) + 1,
        false
      )
    `);

    // 2. Unconditionally wire the column DEFAULT (idempotent in pg)
    await client.query(
      `ALTER TABLE tasks ALTER COLUMN id SET DEFAULT nextval('tasks_id_seq')`
    );

    // 3. Own the sequence so it drops with the column if ever rebuilt
    await client.query(`ALTER SEQUENCE tasks_id_seq OWNED BY tasks.id`);

    // 4. Install trigger function + trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION tasks_assign_id()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS NULL THEN
          NEW.id := nextval('tasks_id_seq');
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await client.query(`DROP TRIGGER IF EXISTS tasks_auto_id ON tasks`);

    await client.query(`
      CREATE TRIGGER tasks_auto_id
        BEFORE INSERT ON tasks
        FOR EACH ROW EXECUTE FUNCTION tasks_assign_id()
    `);

    // 5. Delete remaining null-ID tasks
    const { rows: nullTasks } = await client.query(
      `SELECT user_id, title, created_at FROM tasks WHERE id IS NULL ORDER BY created_at`
    );
    if (nullTasks.length > 0) {
      console.log(`[tasks_id_trigger] purging ${nullTasks.length} null-ID task(s):`);
      nullTasks.forEach(r =>
        console.log(`  user_id=${r.user_id}  title="${r.title}"  created=${r.created_at}`)
      );
      await client.query(`DELETE FROM task_steps WHERE task_id IS NULL`);
      await client.query(`DELETE FROM tasks WHERE id IS NULL`);
    } else {
      console.log(`[tasks_id_trigger] no null-ID tasks found`);
    }

    // 6. Enforce NOT NULL
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

    // Add PRIMARY KEY if missing
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

    console.log('[tasks_id_trigger] done — trigger installed, sequence owned, PK enforced');
  },
};
