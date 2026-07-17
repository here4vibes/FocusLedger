-- Read-only duplicate audit for the constraint remediation.
-- For each unique the code assumes but prod lacks, counts key-groups with >1 row.
-- dup_groups = 0  → safe to add the unique index directly.
-- dup_groups > 0  → that table needs dedup FIRST (keeps one row per key).

SELECT 'ai_extraction_usage (user_id,month)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, month FROM ai_extraction_usage GROUP BY user_id, month HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'bill_preferences (user_id,merchant_key)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, merchant_key FROM bill_preferences GROUP BY user_id, merchant_key HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'buddy_engagement (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM buddy_engagement GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'checkin_mode_preferences (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM checkin_mode_preferences GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'cross_domain_insights (user_id,week_start)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, week_start FROM cross_domain_insights GROUP BY user_id, week_start HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'customer_emails (resend_email_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT resend_email_id FROM customer_emails GROUP BY resend_email_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'email_connections (user_id,provider)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, provider FROM email_connections GROUP BY user_id, provider HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'email_suggestions (user_id,message_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, message_id FROM email_suggestions GROUP BY user_id, message_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'expenses (plaid_transaction_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT plaid_transaction_id FROM expenses GROUP BY plaid_transaction_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'health_score_history (user_id,date)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, date FROM health_score_history GROUP BY user_id, date HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'impulse_spending_alerts (user_id,alert_type,local_date)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, alert_type, local_date FROM impulse_spending_alerts GROUP BY user_id, alert_type, local_date HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'insight_unlocks (user_id,insight_key)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, insight_key FROM insight_unlocks GROUP BY user_id, insight_key HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'ios_waitlist (email)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT email FROM ios_waitlist GROUP BY email HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'journal_trust_metrics (user_id,metric_date)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, metric_date FROM journal_trust_metrics GROUP BY user_id, metric_date HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'lead_magnet_emails (email,lead_magnet_type)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT email, lead_magnet_type FROM lead_magnet_emails GROUP BY email, lead_magnet_type HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'news_cache (url)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT url FROM news_cache GROUP BY url HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'nudge_dismissals (user_id,nudge_type,pattern_key)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, nudge_type, pattern_key FROM nudge_dismissals GROUP BY user_id, nudge_type, pattern_key HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'nudge_preferences (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM nudge_preferences GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'plaid_accounts (account_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT account_id FROM plaid_accounts GROUP BY account_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'plaid_items (institution_id,user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT institution_id, user_id FROM plaid_items GROUP BY institution_id, user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'plaid_items (item_id,user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT item_id, user_id FROM plaid_items GROUP BY item_id, user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'plaid_tokens (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM plaid_tokens GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'plaid_transactions (transaction_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT transaction_id FROM plaid_transactions GROUP BY transaction_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'push_subscriptions (user_id,endpoint)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, endpoint FROM push_subscriptions GROUP BY user_id, endpoint HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'push_tokens (user_id,token)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, token FROM push_tokens GROUP BY user_id, token HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'routine_nudge_events (routine_id,nudge_date)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT routine_id, nudge_date FROM routine_nudge_events GROUP BY routine_id, nudge_date HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'routine_nudge_prefs (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM routine_nudge_prefs GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'routine_streaks (routine_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT routine_id FROM routine_streaks GROUP BY routine_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'spending_sessions (user_id,session_date)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, session_date FROM spending_sessions GROUP BY user_id, session_date HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'task_time_estimations (task_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT task_id FROM task_time_estimations GROUP BY task_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'transaction_classifications (transaction_id,user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT transaction_id, user_id FROM transaction_classifications GROUP BY transaction_id, user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'transactions (plaid_transaction_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT plaid_transaction_id FROM transactions GROUP BY plaid_transaction_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_email_preferences (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM user_email_preferences GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_focus_prefs (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM user_focus_prefs GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_followup_prefs (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM user_followup_prefs GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_notification_prefs (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM user_notification_prefs GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_score_weights (user_id)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id FROM user_score_weights GROUP BY user_id HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'user_weekly_reports (user_id,week_start)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, week_start FROM user_weekly_reports GROUP BY user_id, week_start HAVING COUNT(*) > 1) d
UNION ALL
SELECT 'weekly_stats (user_id,week_start)' AS constraint_needed, COUNT(*) AS dup_groups FROM (SELECT user_id, week_start FROM weekly_stats GROUP BY user_id, week_start HAVING COUNT(*) > 1) d
ORDER BY dup_groups DESC, constraint_needed;

-- Total constraints to add: 39