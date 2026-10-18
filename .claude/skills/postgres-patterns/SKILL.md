---
name: postgres-patterns
description: PostgreSQL patterns for FocusLedger's db/ and migrations/ — index choice, data types, upserts with backing constraints, pagination, safe idempotent migrations on Neon, and catalog queries for missing indexes and constraints. Use when writing SQL, designing a table or migration, or a query is slow.
---

<!-- Adapted from ECC (affaan-m/everything-claude-code, MIT), skills/postgres-patterns at b92f181, based on Supabase Agent Skills (MIT). Supabase RLS and server-tuning (ALTER SYSTEM) sections removed; FocusLedger notes added. -->

# PostgreSQL Patterns (FocusLedger)

Quick reference. For a full review, use the `database-reviewer` agent.

## House rules

- SQL only in `db/`, parameterized, via `pool.query`. Schema changes only in `migrations/`; they run on every deploy, so make them idempotent.
- Check the **real** column type before trusting the code: the prod schema came from Prisma, and genesis `CREATE TABLE IF NOT EXISTS` never ran on existing tables.
- Money is `NUMERIC(12,2)`. Instants are `timestamptz`. Flags are `boolean`.

## Index cheat sheet

| Query pattern | Index | Example |
|---|---|---|
| `WHERE col = v` / `col > v` | B-tree | `CREATE INDEX idx ON t (col)` |
| `WHERE a = x AND b > y` | Composite: equality first, then range | `CREATE INDEX idx ON t (a, b)` |
| Mostly-filtered subset | Partial | `CREATE INDEX idx ON tasks (user_id) WHERE is_completed = false` |
| Read a few columns by key | Covering | `CREATE INDEX idx ON users (email) INCLUDE (name)` |
| `jsonb @> '{...}'` | GIN | `CREATE INDEX idx ON t USING gin (col)` |
| Append-only time series | BRIN | `CREATE INDEX idx ON t USING brin (created_at)` |

Index every foreign key column you join or cascade on. On a large live table use `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (it can't run inside a transaction).

## Common patterns

**Upsert (needs a backing unique constraint):**
```sql
INSERT INTO bill_preferences (user_id, merchant_key, bucket)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, merchant_key) DO UPDATE SET bucket = EXCLUDED.bucket;
```
If `(user_id, merchant_key)` has no unique index, this errors at runtime. Add the constraint in a migration first.

**Batch instead of N+1:**
```sql
SELECT * FROM task_steps WHERE task_id = ANY($1::int[]);
```

**Cursor pagination:**
```sql
SELECT id, title FROM tasks WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT 50;
```

**Job claim without double-processing:**
```sql
UPDATE jobs SET status = 'processing'
WHERE id = (SELECT id FROM jobs WHERE status = 'pending'
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```

## Idempotent migration snippets

```javascript
module.exports = {
  name: '18xxxxxxxxxxx_example',
  up: async (client) => {
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snoozed_until timestamptz`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS routine_task_links_uq
                        ON routine_task_links (routine_id, task_id)`);
    // Change a type only when it's actually wrong (prod may differ from local):
    await client.query(`
      DO $$ BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name = 'tasks' AND column_name = 'description') = 'json' THEN
          ALTER TABLE tasks ALTER COLUMN description TYPE text USING description::text;
        END IF;
      END $$;`);
  },
};
```
Before adding a unique index or NOT NULL, check for duplicates or NULLs first, and clean them up in the same migration or the deploy fails.

## Diagnostic queries (local or a Neon branch)

```sql
-- Real column types for a table
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns WHERE table_name = 'tasks' ORDER BY ordinal_position;

-- Tables with no primary key
SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relkind = 'r'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p');

-- Foreign keys with no supporting index
SELECT c.conrelid::regclass AS tbl, a.attname AS col
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
WHERE c.contype = 'f'
  AND NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey));

-- Plan for a slow query
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

Never run DDL or unscoped writes against production from a session; production changes go through a migration in a PR.
