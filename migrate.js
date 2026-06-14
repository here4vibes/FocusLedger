/**
 * Database Migration Runner
 *
 * Runs on every deploy via `npm run build`.
 *
 * How it works:
 * 1. Creates core tables (users, _migrations) - always runs, idempotent
 * 2. Reads migrations from migrations/ folder
 * 3. Runs new migrations in order (tracked in _migrations table)
 *
 * To create a new migration:
 *   Create a file in migrations/ with format: {timestamp}_{name}.js
 *   Example: migrations/1704067200000_add_products_table.js
 *
 * Migration file format:
 *   module.exports = {
 *     name: 'add_products_table',
 *     up: async (client) => {
 *       await client.query(`CREATE TABLE products (...)`);
 *     }
 *   };
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.log('[migrate] DATABASE_URL not set — skipping (build phase)');
  process.exit(0);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  console.log('Running migrations...');

  const client = await pool.connect();
  try {
    // 1. Create migration tracking table (always first)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Core tables (idempotent - safe to run every time)
    await runCoreMigrations(client);

    // 3. Run migrations from migrations/ folder
    await runFolderMigrations(client);

    console.log('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Core tables that every app needs.
 * These use CREATE IF NOT EXISTS so they're safe to run repeatedly.
 */
async function runCoreMigrations(client) {
  // Users table with subscription support
  // Used by Polsia for syncing end-user subscription status
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      password_hash VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      -- Subscription fields (synced by Polsia when customer subscribes)
      stripe_subscription_id VARCHAR(255),
      subscription_status VARCHAR(50),
      subscription_plan VARCHAR(255),
      subscription_expires_at TIMESTAMPTZ,
      subscription_updated_at TIMESTAMPTZ
    )
  `);

  // Unique constraint on email (required for UPSERT)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))
  `);

  // Index for subscription lookups
  await client.query(`
    CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id)
  `);

  // plaid_accounts balance columns — unconditional, each in its own try/catch
  // so a missing table (fresh DB) or already-existing column never blocks startup.
  const balanceCols = [
    `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS current_balance    NUMERIC(12,2)`,
    `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS available_balance  NUMERIC(12,2)`,
    `ALTER TABLE plaid_accounts ADD COLUMN IF NOT EXISTS balance_updated_at TIMESTAMPTZ`,
    `CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_account_id_unique ON plaid_accounts (account_id)`,
  ];
  for (const sql of balanceCols) {
    try { await client.query(sql); } catch (e) {
      console.warn('[migrate] plaid_accounts patch skipped:', e.message);
    }
  }

  // expenses.plaid_transaction_id: Prisma created this as INTEGER but Plaid IDs are strings.
  // Convert unconditionally (DO $$ guards against re-running on already-VARCHAR columns).
  const expensesPatches = [
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS plaid_transaction_id VARCHAR(255)`,
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'expenses' AND column_name = 'plaid_transaction_id'
           AND data_type = 'integer'
       ) THEN
         DROP INDEX IF EXISTS expenses_plaid_tx_id_unique;
         ALTER TABLE expenses ALTER COLUMN plaid_transaction_id TYPE VARCHAR(255)
           USING plaid_transaction_id::TEXT;
       END IF;
     END$$`,
    `CREATE UNIQUE INDEX IF NOT EXISTS expenses_plaid_tx_id_unique
       ON expenses (plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL`,
  ];
  for (const sql of expensesPatches) {
    try { await client.query(sql); } catch (e) {
      console.warn('[migrate] expenses patch skipped:', e.message);
    }
  }

  // buddy_daily_plans: Prisma created with plan_json JSONB; migration added individual columns
  // that may never have run if the folder runner was blocked by earlier failures.
  const buddyPlanPatches = [
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_1_id       INT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_1_reason   TEXT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_2_id       INT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_2_reason   TEXT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_3_id       INT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS task_3_reason   TEXT`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS accepted         BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE buddy_daily_plans ADD COLUMN IF NOT EXISTS tasks_completed  INT NOT NULL DEFAULT 0`,
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'buddy_daily_plans'::regclass
           AND contype = 'u'
           AND conname = 'buddy_daily_plans_user_id_plan_date_key'
       ) THEN
         DELETE FROM buddy_daily_plans a
         USING buddy_daily_plans b
         WHERE a.user_id = b.user_id
           AND a.plan_date IS NOT DISTINCT FROM b.plan_date
           AND a.id < b.id;
         ALTER TABLE buddy_daily_plans
           ADD CONSTRAINT buddy_daily_plans_user_id_plan_date_key
           UNIQUE (user_id, plan_date);
       END IF;
     END$$`,
  ];
  for (const sql of buddyPlanPatches) {
    try { await client.query(sql); } catch (e) {
      console.warn('[migrate] buddy_daily_plans patch skipped:', e.message);
    }
  }
}

/**
 * Run migrations from migrations/ folder.
 * Each migration runs once and is tracked in _migrations table.
 */
async function runFolderMigrations(client) {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Skip if no migrations folder
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  // Get all migration files, sorted by name (timestamp prefix ensures order)
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    return;
  }

  // Get already-applied migrations
  const applied = await client.query('SELECT name FROM _migrations');
  const appliedNames = new Set(applied.rows.map(r => r.name));

  // Run pending migrations
  for (const file of files) {
    const migration = require(path.join(migrationsDir, file));
    const name = migration.name || file.replace('.js', '');

    if (appliedNames.has(name)) {
      continue; // Already applied
    }

    console.log(`Running migration: ${name}`);

    try {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Migration complete: ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      // Log but don't crash — a stuck migration shouldn't prevent the server
      // from starting with new code. The migration will be retried next deploy.
      console.error(`[migrate] WARNING: migration "${name}" failed and was rolled back: ${err.message}`);
    }
  }
}

migrate().catch(err => {
  console.error('Migration runner error:', err.message);
  process.exit(1);
});
