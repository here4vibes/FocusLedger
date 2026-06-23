'use strict';
/**
 * Ensure every ON CONFLICT clause has a backing UNIQUE index.
 *
 * Root cause: tables created by Prisma or early DDL may have had their
 * UNIQUE constraints added by Prisma's own migration runner. When tables
 * were later re-created via CREATE TABLE IF NOT EXISTS (a no-op on existing
 * tables), any UNIQUE in that DDL never applied. ON CONFLICT (col) without
 * a backing constraint throws "there is no unique or exclusion constraint
 * matching the ON CONFLICT specification" — caught silently → null returned
 * → silent data loss.
 *
 * All operations are idempotent (CREATE UNIQUE INDEX IF NOT EXISTS).
 * Each index is in its own try/catch so one missing table never blocks the rest.
 * Dedup DELETE runs first for compound indexes where duplicates may exist.
 */

const indexes = [
  // nudges — lib/nudgeGenerator.js
  {
    name: 'nudges_user_notification_key_unique',
    dedup: `DELETE FROM nudges a USING nudges b
            WHERE a.user_id = b.user_id AND a.notification_key = b.notification_key AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS nudges_user_notification_key_unique
          ON nudges (user_id, notification_key)`,
  },

  // notification_send_log — db/notifications.js
  {
    name: 'notification_send_log_user_key_date_unique',
    dedup: `DELETE FROM notification_send_log a USING notification_send_log b
            WHERE a.user_id = b.user_id AND a.notification_key = b.notification_key
              AND a.send_date = b.send_date AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS notification_send_log_user_key_date_unique
          ON notification_send_log (user_id, notification_key, send_date)`,
  },

  // push_subscriptions — routes/notifications.js
  {
    name: 'push_subscriptions_user_endpoint_unique',
    dedup: `DELETE FROM push_subscriptions a USING push_subscriptions b
            WHERE a.user_id = b.user_id AND a.endpoint = b.endpoint AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_endpoint_unique
          ON push_subscriptions (user_id, endpoint)`,
  },

  // push_tokens — db/push-tokens.js
  {
    name: 'push_tokens_user_token_unique',
    dedup: `DELETE FROM push_tokens a USING push_tokens b
            WHERE a.user_id = b.user_id AND a.token = b.token AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_user_token_unique
          ON push_tokens (user_id, token)`,
  },

  // health_score_history — routes/health-score.js
  {
    name: 'health_score_history_user_date_unique',
    dedup: `DELETE FROM health_score_history a USING health_score_history b
            WHERE a.user_id = b.user_id AND a.date = b.date AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS health_score_history_user_date_unique
          ON health_score_history (user_id, date)`,
  },

  // user_score_weights — routes/health-score.js
  {
    name: 'user_score_weights_user_id_unique',
    dedup: `DELETE FROM user_score_weights a USING user_score_weights b
            WHERE a.user_id = b.user_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_score_weights_user_id_unique
          ON user_score_weights (user_id)`,
  },

  // user_weekly_reports — routes/alignment-score.js
  {
    name: 'user_weekly_reports_user_week_unique',
    dedup: `DELETE FROM user_weekly_reports a USING user_weekly_reports b
            WHERE a.user_id = b.user_id AND a.week_start = b.week_start AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_weekly_reports_user_week_unique
          ON user_weekly_reports (user_id, week_start)`,
  },

  // nudge_dismissals — routes/alignment-nudges.js
  {
    name: 'nudge_dismissals_user_type_key_unique',
    dedup: `DELETE FROM nudge_dismissals a USING nudge_dismissals b
            WHERE a.user_id = b.user_id AND a.nudge_type = b.nudge_type
              AND a.pattern_key = b.pattern_key AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS nudge_dismissals_user_type_key_unique
          ON nudge_dismissals (user_id, nudge_type, pattern_key)`,
  },

  // evening_nudge_log — jobs/evening-nudge.js
  {
    name: 'evening_nudge_log_user_date_unique',
    dedup: `DELETE FROM evening_nudge_log a USING evening_nudge_log b
            WHERE a.user_id = b.user_id AND a.send_date = b.send_date AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS evening_nudge_log_user_date_unique
          ON evening_nudge_log (user_id, send_date)`,
  },

  // ai_extraction_usage — routes/documents.js
  {
    name: 'ai_extraction_usage_user_month_unique',
    dedup: `DELETE FROM ai_extraction_usage a USING ai_extraction_usage b
            WHERE a.user_id = b.user_id AND a.month = b.month AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS ai_extraction_usage_user_month_unique
          ON ai_extraction_usage (user_id, month)`,
  },

  // email_connections — routes/email.js
  {
    name: 'email_connections_user_provider_unique',
    dedup: `DELETE FROM email_connections a USING email_connections b
            WHERE a.user_id = b.user_id AND a.provider = b.provider AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS email_connections_user_provider_unique
          ON email_connections (user_id, provider)`,
  },

  // linked_emails — db/email-to-tasks.js
  {
    name: 'linked_emails_user_email_unique',
    dedup: `DELETE FROM linked_emails a USING linked_emails b
            WHERE a.user_id = b.user_id AND a.email = b.email AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS linked_emails_user_email_unique
          ON linked_emails (user_id, email)`,
  },

  // email_suggestions — routes/email.js
  {
    name: 'email_suggestions_user_message_unique',
    dedup: `DELETE FROM email_suggestions a USING email_suggestions b
            WHERE a.user_id = b.user_id AND a.message_id = b.message_id AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS email_suggestions_user_message_unique
          ON email_suggestions (user_id, message_id)`,
  },

  // spending_sessions — db/spendingSessions.js
  {
    name: 'spending_sessions_user_date_unique',
    dedup: `DELETE FROM spending_sessions a USING spending_sessions b
            WHERE a.user_id = b.user_id AND a.session_date = b.session_date AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS spending_sessions_user_date_unique
          ON spending_sessions (user_id, session_date)`,
  },

  // impulse_spending_alerts — db/impulseNudges.js
  // ON CONFLICT (user_id, alert_type, local_date) WHERE is_dismissed = false
  // Requires a matching PARTIAL unique index.
  {
    name: 'impulse_alerts_user_type_date_active_unique',
    dedup: `DELETE FROM impulse_spending_alerts a USING impulse_spending_alerts b
            WHERE a.user_id = b.user_id AND a.alert_type = b.alert_type
              AND a.local_date = b.local_date AND a.is_dismissed = false
              AND b.is_dismissed = false AND a.id < b.id`,
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS impulse_alerts_user_type_date_active_unique
          ON impulse_spending_alerts (user_id, alert_type, local_date)
          WHERE is_dismissed = false`,
  },

  // Per-user config tables (ON CONFLICT (user_id)) — likely have Prisma constraints
  // but CREATE UNIQUE INDEX IF NOT EXISTS is a no-op when the index already exists.
  {
    name: 'nudge_preferences_user_id_unique',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS nudge_preferences_user_id_unique
          ON nudge_preferences (user_id)`,
  },
  {
    name: 'checkin_mode_preferences_user_id_unique',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS checkin_mode_preferences_user_id_unique
          ON checkin_mode_preferences (user_id)`,
  },
  {
    name: 'user_email_preferences_user_id_unique',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_email_preferences_user_id_unique
          ON user_email_preferences (user_id)`,
  },
  {
    name: 'buddy_engagement_user_id_unique',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS buddy_engagement_user_id_unique
          ON buddy_engagement (user_id)`,
  },
  {
    name: 'user_focus_prefs_user_id_unique',
    ddl: `CREATE UNIQUE INDEX IF NOT EXISTS user_focus_prefs_user_id_unique
          ON user_focus_prefs (user_id)`,
  },
];

module.exports = {
  name: 'ensure_all_on_conflict_indexes',

  up: async (client) => {
    for (const idx of indexes) {
      try {
        if (idx.dedup) {
          await client.query(idx.dedup);
        }
        await client.query(idx.ddl);
        console.log(`[migration] created index: ${idx.name}`);
      } catch (e) {
        // Non-fatal: table may not exist yet (feature not deployed) or index
        // already exists under a Prisma-generated constraint name.
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
