'use strict';
/**
 * Extend ON CONFLICT index coverage to tables not included in 1783000000000.
 *
 * Gap analysis found these ON CONFLICT clauses have no backing UNIQUE index
 * in migrations — only in lib/plaid-startup-repair.js (which this migration
 * supersedes for DDL purposes). All ops are idempotent. Each in its own
 * try/catch so a missing table never blocks the rest.
 */

const indexes = [
  // weekly_stats — db/insights.js
  {
    name: 'weekly_stats_user_week_unique',
    dedup: `DELETE FROM weekly_stats a USING weekly_stats b
            WHERE a.user_id = b.user_id AND a.week_start = b.week_start AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS weekly_stats_user_week_unique
          ON weekly_stats (user_id, week_start)`,
  },

  // cross_domain_insights — db/insights.js
  {
    name: 'cross_domain_insights_user_week_unique',
    dedup: `DELETE FROM cross_domain_insights a USING cross_domain_insights b
            WHERE a.user_id = b.user_id AND a.week_start = b.week_start AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS cross_domain_insights_user_week_unique
          ON cross_domain_insights (user_id, week_start)`,
  },

  // insight_unlocks — db/insights.js
  {
    name: 'insight_unlocks_user_key_unique',
    dedup: `DELETE FROM insight_unlocks a USING insight_unlocks b
            WHERE a.user_id = b.user_id AND a.insight_key = b.insight_key AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS insight_unlocks_user_key_unique
          ON insight_unlocks (user_id, insight_key)`,
  },

  // user_followup_prefs — db/followupEmails.js
  {
    name: 'user_followup_prefs_user_id_unique',
    dedup: `DELETE FROM user_followup_prefs a USING user_followup_prefs b
            WHERE a.user_id = b.user_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_followup_prefs_user_id_unique
          ON user_followup_prefs (user_id)`,
  },

  // detected_patterns — db/patternDetection.js
  {
    name: 'detected_patterns_user_type_hash_unique',
    dedup: `DELETE FROM detected_patterns a USING detected_patterns b
            WHERE a.user_id = b.user_id AND a.pattern_type = b.pattern_type
              AND a.task_hash = b.task_hash AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS detected_patterns_user_type_hash_unique
          ON detected_patterns (user_id, pattern_type, task_hash)`,
  },

  // task_time_estimations — db/time-estimations.js
  {
    name: 'task_time_estimations_task_id_unique',
    dedup: `DELETE FROM task_time_estimations a USING task_time_estimations b
            WHERE a.task_id = b.task_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS task_time_estimations_task_id_unique
          ON task_time_estimations (task_id)`,
  },

  // routine_streaks — db/routineNudges.js ON CONFLICT (routine_id)
  {
    name: 'routine_streaks_routine_id_unique',
    dedup: `DELETE FROM routine_streaks a USING routine_streaks b
            WHERE a.routine_id = b.routine_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS routine_streaks_routine_id_unique
          ON routine_streaks (routine_id)`,
  },

  // routine_nudge_prefs — db/routineNudges.js ON CONFLICT (user_id)
  {
    name: 'routine_nudge_prefs_user_id_unique',
    dedup: `DELETE FROM routine_nudge_prefs a USING routine_nudge_prefs b
            WHERE a.user_id = b.user_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS routine_nudge_prefs_user_id_unique
          ON routine_nudge_prefs (user_id)`,
  },

  // buddy_checkins — routes/buddy.js ON CONFLICT (user_id, checkin_date, checkin_type)
  {
    name: 'buddy_checkins_user_date_type_unique',
    dedup: `DELETE FROM buddy_checkins a USING buddy_checkins b
            WHERE a.user_id = b.user_id AND a.checkin_date = b.checkin_date
              AND a.checkin_type = b.checkin_type AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS buddy_checkins_user_date_type_unique
          ON buddy_checkins (user_id, checkin_date, checkin_type)`,
  },

  // time_blocks gcal dedup — routes/google-calendar.js
  // ON CONFLICT (user_id, gcal_event_id) — only when gcal_event_id is not null
  {
    name: 'time_blocks_user_gcal_event_unique',
    dedup: `DELETE FROM time_blocks a USING time_blocks b
            WHERE a.user_id = b.user_id AND a.gcal_event_id = b.gcal_event_id
              AND a.gcal_event_id IS NOT NULL AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS time_blocks_user_gcal_event_unique
          ON time_blocks (user_id, gcal_event_id)
          WHERE gcal_event_id IS NOT NULL`,
  },

  // customer_emails — db/customer-emails.js ON CONFLICT (resend_email_id)
  {
    name: 'customer_emails_resend_id_unique',
    dedup: `DELETE FROM customer_emails a USING customer_emails b
            WHERE a.resend_email_id = b.resend_email_id
              AND a.resend_email_id IS NOT NULL AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS customer_emails_resend_id_unique
          ON customer_emails (resend_email_id)
          WHERE resend_email_id IS NOT NULL`,
  },

  // email_tasks_stash — db/email-to-tasks.js ON CONFLICT (message_id)
  {
    name: 'email_tasks_stash_message_id_unique',
    dedup: `DELETE FROM email_tasks_stash a USING email_tasks_stash b
            WHERE a.message_id = b.message_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS email_tasks_stash_message_id_unique
          ON email_tasks_stash (message_id)`,
  },

  // expenses — db/expenses.js ON CONFLICT (plaid_transaction_id) WHERE IS NOT NULL
  // This is the dedup guard for Plaid transactions confirmed to expenses.
  {
    name: 'expenses_plaid_tx_id_unique',
    dedup: `DELETE FROM expenses a USING expenses b
            WHERE a.plaid_transaction_id = b.plaid_transaction_id
              AND a.plaid_transaction_id IS NOT NULL AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS expenses_plaid_tx_id_unique
          ON expenses (plaid_transaction_id)
          WHERE plaid_transaction_id IS NOT NULL`,
  },

  // ios_waitlist — db/waitlist.js ON CONFLICT (email)
  {
    name: 'ios_waitlist_email_unique',
    dedup: `DELETE FROM ios_waitlist a USING ios_waitlist b
            WHERE a.email = b.email AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS ios_waitlist_email_unique
          ON ios_waitlist (email)`,
  },

  // plaid_accounts — startup-repair step 8 (promoted to migration)
  {
    name: 'plaid_accounts_account_id_unique',
    dedup: `DELETE FROM plaid_accounts a USING plaid_accounts b
            WHERE a.account_id = b.account_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS plaid_accounts_account_id_unique
          ON plaid_accounts (account_id)`,
  },

  // lead_magnet_emails — startup-repair step 7 (promoted to migration)
  {
    name: 'lead_magnet_emails_email_type_unique',
    dedup: `DELETE FROM lead_magnet_emails a USING lead_magnet_emails b
            WHERE a.email = b.email AND a.lead_magnet_type = b.lead_magnet_type AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS lead_magnet_emails_email_type_unique
          ON lead_magnet_emails (email, lead_magnet_type)`,
  },

  // news_cache — startup-repair step 6 (promoted to migration)
  {
    name: 'news_cache_url_unique',
    dedup: null,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS news_cache_url_unique
          ON news_cache (url)`,
  },

  // plaid_items — also needs a partial index on (item_id, user_id) for the
  // legacy upsertPlaidItem path that uses ON CONFLICT (item_id, user_id)
  {
    name: 'plaid_items_item_user_unique',
    dedup: `DELETE FROM plaid_items a USING plaid_items b
            WHERE a.item_id = b.item_id AND a.user_id = b.user_id
              AND a.item_id IS NOT NULL AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS plaid_items_item_user_unique
          ON plaid_items (item_id, user_id)
          WHERE item_id IS NOT NULL`,
  },
];

module.exports = {
  name: 'extend_on_conflict_indexes',

  up: async (client) => {
    // SAVEPOINT per index — a plain try/catch inside the runner's single
    // transaction lets one failure abort every statement after it (see the
    // matching fix in ensure_all_on_conflict_indexes).
    for (const idx of indexes) {
      await client.query('SAVEPOINT idx_sp');
      try {
        if (idx.dedup) {
          await client.query(idx.dedup);
        }
        await client.query(idx.ddl);
        await client.query('RELEASE SAVEPOINT idx_sp');
        console.log(`[migration] created index: ${idx.name}`);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT idx_sp');
        console.warn(`[migration] ${idx.name} skipped: ${e.message}`);
      }
    }
  },

  down: async (client) => {
    for (const idx of indexes) {
      try {
        await client.query(`DROP INDEX IF EXISTS ${idx.name}`);
      } catch (_) {}
    }
  },
};
