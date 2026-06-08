'use strict';
/**
 * Add columns missing from expenses, users, and money-related tables.
 * All statements use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS — safe to re-run.
 */
module.exports = {
  name: 'add_missing_money_columns',

  up: async (client) => {
    // -- expenses: description + plaid dedup key ----------------------------
    await client.query(`
      ALTER TABLE expenses
        ADD COLUMN IF NOT EXISTS description          TEXT,
        ADD COLUMN IF NOT EXISTS plaid_transaction_id VARCHAR(255) UNIQUE
    `);

    // -- users: Pro/Tandem grant columns + OAuth fields ----------------------
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS admin_pro_override         BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS pro_granted_by             VARCHAR(50),
        ADD COLUMN IF NOT EXISTS pro_granted_until          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS autopilot_expires_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tandem_plan                VARCHAR(50),
        ADD COLUMN IF NOT EXISTS tandem_expires_at          TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tandem_trial_activated_at  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS google_id                  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS auth_method                VARCHAR(20) DEFAULT 'password',
        ADD COLUMN IF NOT EXISTS avatar_url                 TEXT,
        ADD COLUMN IF NOT EXISTS timezone                   VARCHAR(100),
        ADD COLUMN IF NOT EXISTS is_qa_user                 BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS values_banner_dismissed    BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS previous_checkin_summary   TEXT,
        ADD COLUMN IF NOT EXISTS last_login_at              TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_active_at             TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS login_count                INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS utm_source                 VARCHAR(255),
        ADD COLUMN IF NOT EXISTS utm_medium                 VARCHAR(255),
        ADD COLUMN IF NOT EXISTS utm_campaign               VARCHAR(255),
        ADD COLUMN IF NOT EXISTS utm_content                VARCHAR(255),
        ADD COLUMN IF NOT EXISTS utm_term                   VARCHAR(255),
        ADD COLUMN IF NOT EXISTS signup_referrer            TEXT
    `);

    // -- app_subscription: create if not exists (Pro gating depends on this) --
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_subscription (
        id                     SERIAL PRIMARY KEY,
        user_id                INT NOT NULL,
        plan                   VARCHAR(20) NOT NULL DEFAULT 'free',
        status                 VARCHAR(20) NOT NULL DEFAULT 'active',
        billing_cycle          VARCHAR(20),
        stripe_subscription_id VARCHAR(255) UNIQUE,
        checkout_session_id    VARCHAR(255) UNIQUE,
        activated_at           TIMESTAMPTZ,
        cancelled_at           TIMESTAMPTZ,
        current_period_end     TIMESTAMPTZ,
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_subscription_user_id ON app_subscription (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_app_subscription_status  ON app_subscription (status)`);

    // -- categories: seed the 10 FocusLedger slugs if table is empty ---------
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        color      VARCHAR(20)  NOT NULL DEFAULT '#6B6B80',
        icon       VARCHAR(10)  NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO categories (name, color, icon)
      SELECT unnest(ARRAY['Housing','Bills','Groceries','Food & Delivery','Subscriptions','Shopping','Transport','Health','Fun','Other']),
             unnest(ARRAY['#4A9292','#5B7FA4','#4A8C5C','#C4763A','#7A5BAD','#AD5B8C','#4A6BAD','#5BAD7A','#AD7A4A','#6B6B80']),
             unnest(ARRAY['🏠','📄','🛒','🍕','🔄','🛍️','🚗','🏥','🎮','📦'])
      WHERE NOT EXISTS (SELECT 1 FROM categories LIMIT 1)
    `);

    // -- plaid_items: bank connection records ---------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS plaid_items (
        id               SERIAL PRIMARY KEY,
        user_id          INT NOT NULL,
        access_token     TEXT NOT NULL,
        item_id          VARCHAR(255),
        institution_name VARCHAR(255),
        institution_id   VARCHAR(255),
        cursor           TEXT,
        last_synced_at   TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plaid_items_user_id ON plaid_items (user_id)`);

    // -- plaid_accounts: individual bank accounts per plaid_item ---------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS plaid_accounts (
        id            SERIAL PRIMARY KEY,
        plaid_item_id INT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
        user_id       INT NOT NULL,
        account_id    VARCHAR(255) NOT NULL UNIQUE,
        name          VARCHAR(255),
        official_name VARCHAR(255),
        type          VARCHAR(50),
        subtype       VARCHAR(50),
        mask          VARCHAR(10)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plaid_accounts_user_id      ON plaid_accounts (user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plaid_accounts_plaid_item_id ON plaid_accounts (plaid_item_id)`);

    // -- plaid_transactions: imported transactions for review ------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS plaid_transactions (
        id               SERIAL PRIMARY KEY,
        plaid_account_id INT NOT NULL REFERENCES plaid_accounts(id) ON DELETE CASCADE,
        user_id          INT NOT NULL,
        transaction_id   VARCHAR(255) NOT NULL UNIQUE,
        amount           NUMERIC(12,2) NOT NULL,
        description      TEXT,
        merchant_name    VARCHAR(255),
        category_id      INT,
        plaid_category   VARCHAR(255),
        transaction_date DATE,
        is_pending       BOOLEAN NOT NULL DEFAULT FALSE,
        is_confirmed     BOOLEAN NOT NULL DEFAULT FALSE,
        expense_id       INT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plaid_txs_user_date ON plaid_transactions (user_id, transaction_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plaid_txs_account   ON plaid_transactions (plaid_account_id)`);

    // -- bill_preferences: per-user auto-task toggle per merchant --------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS bill_preferences (
        id                    SERIAL PRIMARY KEY,
        user_id               INT NOT NULL,
        merchant_key          VARCHAR(255) NOT NULL,
        merchant_display_name VARCHAR(255),
        bill_type             VARCHAR(50),
        is_disabled           BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, merchant_key)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bill_prefs_user_id ON bill_preferences (user_id)`);
  },

  down: async (client) => {
    await client.query(`
      ALTER TABLE expenses
        DROP COLUMN IF EXISTS description,
        DROP COLUMN IF EXISTS plaid_transaction_id
    `);
  },
};
