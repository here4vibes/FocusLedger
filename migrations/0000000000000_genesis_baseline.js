'use strict';
/**
 * migrations/0000000000000_genesis_baseline.js
 * AUTO-GENERATED from production information_schema (104 tables).
 * Idempotent: CREATE TABLE IF NOT EXISTS — a no-op on prod (tables already
 * exist), full schema on a fresh DB. Makes the schema reproducible from source.
 * NOTE: columns + types + defaults only. PK/unique/FK + indexes are added by a
 * follow-up migration from Query 2/3 (or pg_dump). Runs first (timestamp 0).
 */
module.exports = {
  name: 'genesis_baseline',
  up: async (client) => {
    await client.query(`CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name TEXT,
  applied_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS account_deletion_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  token_hash TEXT,
  expires_at TIMESTAMPTZ,
  used BOOLEAN,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS adhd_tax_leads (
  id SERIAL PRIMARY KEY,
  email TEXT,
  source TEXT,
  results_json JSON,
  share_hash TEXT,
  email_sent_at TIMESTAMPTZ,
  user_id INTEGER,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ai_extraction_usage (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  month DATE,
  extraction_count INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ai_task_suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  value_id INTEGER,
  suggestion_title TEXT,
  suggestion_steps JSON,
  status TEXT,
  generated_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  visitor_hash TEXT,
  user_id INTEGER,
  event_name TEXT,
  event_data JSON,
  occurred_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS app_subscription (
  id SERIAL PRIMARY KEY,
  plan TEXT,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  status TEXT,
  billing_cycle TEXT,
  current_period_end TEXT,
  activated_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  user_id INTEGER,
  checkout_session_id TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS bill_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  merchant_key TEXT,
  merchant_display_name TEXT,
  bill_type TEXT,
  is_disabled BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  checkin_date DATE,
  checkin_type TEXT,
  selected_task_id INTEGER,
  tasks_completed INTEGER,
  tasks_open INTEGER,
  created_at TIMESTAMPTZ,
  energy_level TEXT,
  blocks_text TEXT,
  tasks_completed_today INTEGER,
  routines_kept_today INTEGER,
  documents_handled INTEGER,
  money_tasks_done INTEGER,
  UNIQUE (user_id, checkin_date, checkin_type)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_conversations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  session_date DATE,
  turn INTEGER,
  role TEXT,
  message TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_daily_plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  plan_date DATE,
  mood TEXT,
  task_1_id INTEGER,
  task_1_reason TEXT,
  task_2_id INTEGER,
  task_2_reason TEXT,
  task_3_id INTEGER,
  task_3_reason TEXT,
  accepted BOOLEAN,
  tasks_completed INTEGER,
  created_at TIMESTAMPTZ,
  task_1_cue TEXT,
  task_2_cue TEXT,
  task_3_cue TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, plan_date)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_demo_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT,
  message_count INTEGER,
  extracted_tasks JSON,
  surfaced_values JSON,
  detected_mood TEXT,
  conversation_summary TEXT,
  is_complete BOOLEAN,
  claimed_user_id INTEGER,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_demo_turns (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  turn INTEGER,
  role TEXT,
  message TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_engagement (
  user_id INTEGER,
  consecutive_missed_checkins INTEGER,
  hook_restart_count INTEGER,
  last_checkin_at TIMESTAMPTZ,
  last_restart_at TIMESTAMPTZ,
  last_processed_date DATE,
  lapse_started_at TIMESTAMPTZ,
  lapse_push_sent BOOLEAN,
  lapse_day5_email_sent BOOLEAN,
  lapse_day14_email_sent BOOLEAN,
  updated_at TIMESTAMPTZ,
  last_comeback_shown_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_midday_checkins (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  checkin_type TEXT,
  plan_id INTEGER,
  response TEXT,
  checkin_date DATE,
  created_at TIMESTAMPTZ,
  UNIQUE (user_id, checkin_date, checkin_type)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS buddy_patterns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  pattern_type TEXT,
  pattern_data TEXT,
  detected_at TIMESTAMPTZ,
  surfaced TEXT,
  dismissed TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  weekly_amount INTEGER,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  user_id INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT,
  color TEXT,
  icon TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS checkin_mode_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  preferred_mode TEXT,
  form_sessions INTEGER,
  form_completions INTEGER,
  form_skips INTEGER,
  conv_sessions INTEGER,
  conv_completions INTEGER,
  conv_skips INTEGER,
  total_sessions INTEGER,
  manual_override BOOLEAN,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS contact_submissions (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  message TEXT,
  category TEXT,
  status TEXT,
  user_id INTEGER,
  page_url TEXT,
  browser_info TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS coverage_gaps_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  gap_type TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS cross_domain_insights (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  week_start DATE NOT NULL,
  insight_text TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS customer_emails (
  id SERIAL PRIMARY KEY,
  from_email TEXT,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  in_reply_to TEXT,
  thread_id TEXT,
  direction TEXT,
  resend_email_id TEXT,
  resend_message_id TEXT,
  received_at TIMESTAMPTZ,
  read BOOLEAN,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS daily_reveals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  reveal_date DATE NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  science_tag VARCHAR(60),
  reveal_type VARCHAR(30) NOT NULL DEFAULT 'insight'::character varying,
  viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_label VARCHAR(160),
  source_url TEXT,
  UNIQUE (user_id, reveal_date)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS detected_patterns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  pattern_type TEXT,
  pattern_data TEXT,
  occurrence_count INTEGER,
  total_opportunities TEXT,
  time_consistency_score INTEGER,
  confidence_score INTEGER,
  is_active BOOLEAN,
  last_detected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  task_hash TEXT NOT NULL DEFAULT ''::text,
  UNIQUE (user_id, pattern_type, task_hash)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  category TEXT,
  s3_url TEXT,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ,
  expiry_date DATE,
  metadata_json JSON,
  linked_policy_id INTEGER,
  notes TEXT,
  ai_extracted BOOLEAN,
  extraction_status TEXT,
  extraction_confidence JSON,
  metadata_confirmed BOOLEAN
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_campaigns (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  audience VARCHAR(30) NOT NULL DEFAULT 'all'::character varying,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'::character varying,
  recipient_count INTEGER,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  provider TEXT,
  email_address TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  is_active BOOLEAN,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  to_email TEXT,
  subject TEXT,
  template_type TEXT,
  status TEXT,
  resend_message_id TEXT,
  opened_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  email_account_id INTEGER,
  message_id TEXT,
  suggested_title TEXT,
  suggested_due_date DATE,
  suggested_amount INTEGER,
  confidence_score NUMERIC(12,2),
  confidence_reasons JSON,
  source_subject TEXT,
  source_from TEXT,
  source_date TEXT,
  status TEXT,
  linked_task_id INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_suppression (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  reason VARCHAR(60) NOT NULL DEFAULT 'reply_opt_out'::character varying,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS email_tasks_stash (
  id SERIAL PRIMARY KEY,
  token TEXT,
  from_email TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  message_id INTEGER,
  expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  UNIQUE (message_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS evening_nudge_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  send_date DATE,
  sent_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  event_type TEXT,
  payload JSON,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  amount NUMERIC(12,2),
  description TEXT,
  category_id INTEGER,
  expense_date DATE,
  created_at TIMESTAMPTZ,
  user_id INTEGER,
  plaid_transaction_id VARCHAR(255),
  source TEXT,
  recurring_expense_id INTEGER,
  value_id INTEGER,
  is_impulse BOOLEAN,
  plaid_original_category TEXT,
  note TEXT,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS express_sessions (
  sid TEXT,
  sess JSON,
  expire TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS feature_suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  title TEXT,
  description TEXT,
  status TEXT,
  reward_applied TEXT,
  reward_amount_cents INTEGER,
  reward_notified TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  task_id INTEGER,
  planned_duration_seconds INTEGER,
  actual_duration_seconds INTEGER,
  completed BOOLEAN,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS followup_email_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  email_type TEXT,
  trigger_ref TEXT,
  trigger_label TEXT,
  subject TEXT,
  sent_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS followup_email_types (
  id TEXT PRIMARY KEY,
  label TEXT,
  description TEXT,
  default_enabled BOOLEAN,
  default_hour INTEGER,
  is_active BOOLEAN
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  date DATE,
  overall_score INTEGER,
  documents_score INTEGER,
  insurance_score INTEGER,
  tasks_score INTEGER,
  bills_score INTEGER,
  weights_json TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS impulse_spending_alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  alert_type TEXT,
  local_date DATE,
  message TEXT,
  is_dismissed BOOLEAN,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS insight_unlocks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  insight_key TEXT,
  unlocked_at TIMESTAMPTZ,
  viewed TEXT,
  interacted TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS insurance_policies (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  type TEXT,
  provider TEXT,
  policy_number TEXT,
  coverage_amount INTEGER,
  premium_monthly TEXT,
  expiry_date DATE,
  document_id INTEGER,
  notes TEXT,
  inferred_from_plaid BOOLEAN,
  plaid_merchant TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ios_waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT,
  source TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  entry_type TEXT,
  content TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  ai_processed_at TIMESTAMPTZ,
  partial_note TEXT,
  user_approved_at TIMESTAMPTZ,
  user_rejected_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS journal_matches (
  id SERIAL PRIMARY KEY,
  journal_entry_id INTEGER,
  task_id INTEGER,
  user_id INTEGER,
  confidence NUMERIC(12,2),
  matched_phrase TEXT,
  match_type TEXT,
  progress_note TEXT,
  followup_task_title TEXT,
  user_approved BOOLEAN,
  approved_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  task_completed BOOLEAN,
  task_completed_at TIMESTAMPTZ,
  completion_undone BOOLEAN,
  completion_undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS journal_trust_metrics (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  metric_date DATE,
  suggestions_shown INTEGER,
  suggestions_approved INTEGER,
  suggestions_dismissed INTEGER,
  completions_undone INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS lead_magnet_emails (
  id SERIAL PRIMARY KEY,
  email TEXT,
  lead_magnet_type TEXT,
  source_page TEXT,
  captured_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS linked_emails (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  email TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  UNIQUE (user_id, email)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS morning_nudge_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  send_date DATE,
  task_count INTEGER,
  sent_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS morning_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  session_date DATE,
  tasks_completed INTEGER,
  tasks_skipped INTEGER,
  completed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS morning_streaks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  current_streak INTEGER,
  longest_streak INTEGER,
  last_completed_date DATE,
  grace_day_available BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS morning_task_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  task_id INTEGER,
  event_type TEXT,
  session_date DATE,
  occurred_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS news_cache (
  id SERIAL PRIMARY KEY,
  source_feed_id INTEGER,
  headline TEXT,
  url TEXT,
  source_name TEXT,
  source_domain TEXT,
  image_url TEXT,
  description TEXT,
  published_at TIMESTAMPTZ,
  category TEXT,
  bias_rating TEXT,
  fetched_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS news_source_bias (
  id SERIAL PRIMARY KEY,
  source_domain TEXT,
  source_name TEXT,
  bias_rating TEXT,
  last_updated TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS notification_send_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  notification_key TEXT,
  notification_type TEXT,
  send_date DATE,
  sent_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS nudge_dismissals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  nudge_type TEXT,
  pattern_key TEXT,
  dismissed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS nudge_interactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  nudge_context TEXT,
  action TEXT,
  value_id INTEGER,
  occurred_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS nudge_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  push_enabled BOOLEAN,
  buddy_enabled BOOLEAN,
  email_enabled BOOLEAN,
  banner_enabled BOOLEAN,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS nudges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  type TEXT,
  source_type TEXT,
  source_id INTEGER,
  message TEXT,
  urgency TEXT,
  status TEXT,
  deliver_after TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  action_url TEXT,
  action_label TEXT,
  notification_key VARCHAR(255),
  UNIQUE (user_id, notification_key)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS one_off_email_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  campaign VARCHAR(80) NOT NULL,
  email VARCHAR(255),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, campaign)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS partner_concerns (
  id SERIAL PRIMARY KEY,
  partnership_id INTEGER,
  from_user_id INTEGER,
  about_user_id INTEGER,
  concern_text TEXT,
  topic_area TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_consumed BOOLEAN,
  consumed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS partnerships (
  id SERIAL PRIMARY KEY,
  inviter_id INTEGER,
  invitee_id INTEGER,
  status TEXT,
  invite_token TEXT,
  invite_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  dissolved_at TIMESTAMPTZ,
  tandem_trial_activated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  token_hash TEXT,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_accounts (
  id SERIAL PRIMARY KEY,
  plaid_item_id INTEGER,
  user_id INTEGER,
  account_id TEXT,
  name TEXT,
  official_name TEXT,
  type TEXT,
  subtype TEXT,
  mask TEXT,
  created_at TIMESTAMPTZ,
  current_balance NUMERIC(12,2),
  available_balance NUMERIC(12,2),
  balance_updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  access_token TEXT,
  item_id TEXT,
  institution_name TEXT,
  institution_id TEXT,
  cursor TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  access_token TEXT,
  item_id INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  institution_name TEXT,
  institution_id INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS plaid_transactions (
  id SERIAL PRIMARY KEY,
  plaid_account_id INTEGER,
  user_id INTEGER,
  transaction_id TEXT,
  amount NUMERIC(12,2),
  description TEXT,
  merchant_name TEXT,
  category_id INTEGER,
  plaid_category TEXT,
  transaction_date DATE,
  is_confirmed BOOLEAN,
  is_pending BOOLEAN,
  expense_id INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code TEXT,
  type TEXT,
  value INTEGER,
  max_redemptions INTEGER,
  redemption_count INTEGER,
  expires_at TIMESTAMPTZ,
  created_by INTEGER,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS promo_redemptions (
  id SERIAL PRIMARY KEY,
  promo_code_id INTEGER,
  user_id INTEGER,
  redeemed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  endpoint TEXT,
  subscription JSON,
  enabled BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  UNIQUE (user_id, endpoint)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  token TEXT,
  platform TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS recurring_expenses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  description TEXT,
  amount INTEGER,
  category_id INTEGER,
  frequency TEXT,
  start_date DATE,
  is_paused BOOLEAN,
  next_due_date DATE,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS recurring_tasks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  title TEXT,
  description TEXT,
  priority TEXT,
  frequency TEXT,
  day_of_week TEXT,
  day_of_month TEXT,
  start_date DATE,
  end_date DATE,
  is_paused BOOLEAN,
  next_due_date DATE,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_nudge_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  routine_id INTEGER,
  nudge_date DATE,
  status TEXT,
  skip_count INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_nudge_prefs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  nudges_enabled BOOLEAN,
  frequency TEXT,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_streaks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  routine_id INTEGER,
  current_streak TEXT,
  best_streak TEXT,
  last_completed_date DATE,
  updated_at TIMESTAMPTZ,
  freeze_available BOOLEAN NOT NULL DEFAULT true,
  last_freeze_used_date DATE
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  pattern_id INTEGER,
  status TEXT,
  presented_count TIMESTAMPTZ,
  presented_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_routine_id TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_task_links (
  id SERIAL PRIMARY KEY,
  routine_id INTEGER,
  task_id INTEGER,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routine_templates (
  id SERIAL PRIMARY KEY,
  name TEXT,
  category TEXT,
  description TEXT,
  estimated_minutes INTEGER,
  tasks JSON,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS routines (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  name TEXT,
  routine_type TEXT,
  nudge_after_hour INTEGER,
  day_of_week TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  source_template_id INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS rss_feeds (
  id SERIAL PRIMARY KEY,
  name TEXT,
  url TEXT,
  source_domain TEXT,
  category TEXT,
  is_active BOOLEAN,
  last_fetched_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS session (
  sid VARCHAR(255) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS spending_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  session_date DATE,
  transaction_count INTEGER,
  complete BOOLEAN,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS task_steps (
  id SERIAL PRIMARY KEY,
  task_id INTEGER,
  title TEXT,
  is_completed BOOLEAN,
  sort_order INTEGER,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS task_substeps (
  id SERIAL PRIMARY KEY,
  task_id INTEGER,
  user_id INTEGER,
  step_text TEXT,
  step_order TEXT,
  completed BOOLEAN,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS task_time_estimations (
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  task_id INTEGER,
  estimated_minutes INTEGER,
  actual_minutes INTEGER,
  estimated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  calibration_score INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT,
  description JSON,
  is_completed BOOLEAN,
  priority TEXT,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  user_id INTEGER,
  source TEXT,
  merchant_hint TEXT,
  expected_amount INTEGER,
  auto_complete_note BOOLEAN,
  auto_complete_transaction_id INTEGER,
  bill_merchant_key TEXT,
  bill_type TEXT,
  due_time TEXT,
  recurring_task_id INTEGER,
  value_id INTEGER,
  source_ref TEXT,
  duration_minutes INTEGER,
  duration_source TEXT,
  notes TEXT,
  is_household BOOLEAN,
  is_shared_with_partner BOOLEAN,
  recurrence_type TEXT,
  recurrence_day TEXT,
  anchor_routine_id INTEGER,
  anchor_label TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS time_blocks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  value_id INTEGER,
  title TEXT,
  block_date DATE,
  start_time TEXT,
  end_time TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  task_id INTEGER,
  source VARCHAR(20) NOT NULL DEFAULT 'manual'::character varying,
  gcal_event_id VARCHAR(255)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS transaction_classifications (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  user_id INTEGER,
  transaction_id INTEGER,
  classification TEXT,
  swiped_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  plaid_transaction_id INTEGER,
  user_id INTEGER,
  merchant_name TEXT,
  amount INTEGER,
  category TEXT,
  category_icon TEXT,
  date DATE,
  pending BOOLEAN,
  logo_url TEXT,
  created_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_email_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  weekly_nudge TEXT,
  re_engagement TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_focus_prefs (
  user_id INTEGER,
  body_double_enabled BOOLEAN,
  ambient_style TEXT,
  ambient_volume TEXT,
  updated_at TIMESTAMPTZ,
  break_interval_minutes INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_followup_prefs (
  user_id INTEGER,
  task_reminder BOOLEAN DEFAULT true,
  task_reminder_hour INTEGER,
  routine_streak BOOLEAN DEFAULT true,
  routine_streak_hour INTEGER,
  weekly_summary BOOLEAN DEFAULT true,
  weekly_summary_hour INTEGER,
  follow_through BOOLEAN DEFAULT true,
  follow_through_hour INTEGER,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id INTEGER,
  evening_enabled BOOLEAN,
  evening_time TEXT,
  push_token TEXT,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_score_weights (
  user_id INTEGER,
  documents TEXT,
  insurance TEXT,
  tasks TEXT,
  bills TEXT,
  updated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_values (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  rank INTEGER,
  color TEXT,
  weekly_hours_target INTEGER,
  weekly_spend_target INTEGER,
  category_id INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  value_name TEXT,
  icon TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS user_weekly_reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  week_start DATE,
  overall_score INTEGER,
  task_score INTEGER,
  spending_score INTEGER,
  breakdown_json JSON,
  generated_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT,
  name TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  subscription_plan TEXT,
  subscription_expires_at TIMESTAMPTZ,
  subscription_updated_at TIMESTAMPTZ,
  is_admin BOOLEAN,
  values_setup_skipped_count INTEGER,
  admin_pro_override BOOLEAN,
  email_autosuggest_enabled BOOLEAN,
  login_count INTEGER,
  last_login_at TIMESTAMPTZ,
  values_banner_dismissed_at TIMESTAMPTZ,
  auth_method TEXT,
  google_id TEXT,
  city TEXT,
  state_region TEXT,
  zip_code TEXT,
  country TEXT,
  last_active_at TIMESTAMPTZ,
  timezone TEXT,
  notif_morning_enabled BOOLEAN,
  notif_evening_enabled BOOLEAN,
  notif_morning_hour INTEGER,
  notif_evening_hour INTEGER,
  avatar_url TEXT,
  is_qa_user BOOLEAN,
  login_checkin_done_date DATE,
  login_last_mood TEXT,
  pro_granted_by TEXT,
  pro_granted_until TIMESTAMPTZ,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  signup_referrer TEXT,
  session_count INTEGER,
  previous_checkin_summary TEXT,
  first_session_insights_done BOOLEAN,
  autopilot_expires_at TIMESTAMPTZ,
  tandem_plan TEXT,
  tandem_expires_at TIMESTAMPTZ,
  tandem_trial_started_at TIMESTAMPTZ,
  buddy_hook_restart_count INTEGER,
  buddy_bubble_visible BOOLEAN,
  buddy_bubble_position JSON,
  hourly_rate NUMERIC(10,2),
  tandem_trial_activated_at TIMESTAMPTZ,
  values_banner_dismissed BOOLEAN NOT NULL DEFAULT false,
  onboarding_completed_at TIMESTAMPTZ,
  adhd_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  gcal_access_token TEXT,
  gcal_refresh_token TEXT,
  gcal_token_expiry TIMESTAMPTZ,
  gcal_synced_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS value_category_mappings (
  id SERIAL PRIMARY KEY,
  value_id INTEGER,
  user_id INTEGER,
  category_type TEXT,
  category_name TEXT,
  is_default BOOLEAN,
  created_at TIMESTAMPTZ,
  keywords TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS visitor_sessions (
  id SERIAL PRIMARY KEY,
  visitor_hash TEXT,
  page TEXT,
  visited_at TIMESTAMPTZ,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  device_type TEXT
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS weekly_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  week_start TEXT,
  tasks_completed BOOLEAN,
  tasks_created TIMESTAMPTZ,
  total_focus_minutes INTEGER,
  total_spend_cents INTEGER,
  impulse_count INTEGER,
  planned_count INTEGER,
  evening_sessions_completed BOOLEAN,
  routines_completed BOOLEAN,
  streak_days TEXT,
  computed_at TIMESTAMPTZ
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS work_hour_blocks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  day_of_week INTEGER,
  start_time TEXT,
  end_time TEXT,
  label TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
    )`);
  },
};
