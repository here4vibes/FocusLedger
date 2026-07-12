'use strict';

async function getEmailTypes(pool) {
  const { rows } = await pool.query('SELECT * FROM followup_email_types ORDER BY id');
  return rows;
}

async function getUserPrefs(pool, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM user_followup_prefs WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function upsertUserPrefs(pool, userId, prefs) {
  const {
    task_reminder, task_reminder_hour,
    routine_streak, routine_streak_hour,
    weekly_summary, weekly_summary_hour,
    follow_through, follow_through_hour,
  } = prefs;
  await pool.query(
    `INSERT INTO user_followup_prefs
       (user_id, task_reminder, task_reminder_hour, routine_streak, routine_streak_hour,
        weekly_summary, weekly_summary_hour, follow_through, follow_through_hour)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id) DO UPDATE SET
       task_reminder       = $2, task_reminder_hour  = $3,
       routine_streak      = $4, routine_streak_hour = $5,
       weekly_summary      = $6, weekly_summary_hour = $7,
       follow_through      = $8, follow_through_hour = $9,
       updated_at          = NOW()`,
    [userId,
     task_reminder,   task_reminder_hour,
     routine_streak,  routine_streak_hour,
     weekly_summary,  weekly_summary_hour,
     follow_through,  follow_through_hour]
  );
}

async function getRecentLogs(pool, userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, email_type, trigger_ref, trigger_label, subject, sent_at
     FROM followup_email_log WHERE user_id = $1 ORDER BY sent_at DESC LIMIT $2`,
    [userId, Math.min(limit, 100)]
  );
  return rows;
}

// ── Job-only helpers ──────────────────────────────────────────────────────────

async function getProUsersWithPrefs(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.timezone,
            COALESCE(p.task_reminder,  true)  AS task_reminder,
            COALESCE(p.task_reminder_hour, 9) AS task_reminder_hour,
            COALESCE(p.routine_streak, true)  AS routine_streak,
            COALESCE(p.routine_streak_hour, 9) AS routine_streak_hour,
            COALESCE(p.weekly_summary, true)  AS weekly_summary,
            COALESCE(p.weekly_summary_hour, 9) AS weekly_summary_hour,
            COALESCE(p.follow_through, true)  AS follow_through,
            COALESCE(p.follow_through_hour, 9) AS follow_through_hour
     FROM users u
     LEFT JOIN user_followup_prefs p ON p.user_id = u.id
     WHERE u.admin_pro_override = true
       OR (u.pro_granted_until IS NOT NULL AND u.pro_granted_until > NOW())
       OR EXISTS (
         SELECT 1 FROM app_subscription s
         WHERE s.user_id = u.id AND s.status = 'active' AND s.plan IN ('pro','autopilot')
       )
     AND NOT EXISTS (
       SELECT 1 FROM email_suppression es WHERE LOWER(es.email) = LOWER(u.email)
     )`
  );
  return rows;
}

async function getIncompleteTasksDue(pool, userId, dueStr) {
  const { rows } = await pool.query(
    `SELECT id, title FROM tasks
     WHERE user_id = $1 AND is_completed = false AND due_date = $2::date
     ORDER BY created_at LIMIT 5`,
    [userId, dueStr]
  );
  return rows;
}

async function getActiveStreakRoutines(pool, userId, minStreak = 3) {
  const { rows } = await pool.query(
    `SELECT r.id AS routine_id, r.name AS routine_name, rs.current_streak
     FROM routine_streaks rs
     JOIN routines r ON r.id = rs.routine_id
     WHERE rs.user_id = $1 AND rs.current_streak >= $2
     ORDER BY rs.current_streak DESC LIMIT 3`,
    [userId, minStreak]
  );
  return rows;
}

async function getWeeklyStats(pool, userId, weekMonday) {
  const { rows } = await pool.query(
    `SELECT tasks_due::text, tasks_completed::text
     FROM weekly_stats WHERE user_id = $1 AND week_start = $2::date LIMIT 1`,
    [userId, weekMonday]
  );
  return rows[0] || { tasks_due: '0', tasks_completed: '0' };
}

async function getPastDueTasks(pool, userId, yesterday) {
  const { rows } = await pool.query(
    `SELECT id, title, due_date FROM tasks
     WHERE user_id = $1 AND is_completed = false AND due_date < $2::date
     ORDER BY due_date ASC LIMIT 3`,
    [userId, yesterday]
  );
  return rows;
}

async function alreadySentToday(pool, userId, emailType, triggerRef) {
  const { rows } = await pool.query(
    `SELECT id FROM followup_email_log
     WHERE user_id = $1 AND email_type = $2 AND trigger_ref = $3
       AND sent_at::date = CURRENT_DATE LIMIT 1`,
    [userId, emailType, triggerRef]
  );
  return rows.length > 0;
}

async function alreadySentThisWeek(pool, userId, emailType, weekMonday) {
  const { rows } = await pool.query(
    `SELECT id FROM followup_email_log
     WHERE user_id = $1 AND email_type = $2 AND trigger_ref = $3
       AND sent_at >= $3::date LIMIT 1`,
    [userId, emailType, weekMonday]
  );
  return rows.length > 0;
}

async function logSent(pool, { userId, emailType, triggerRef, triggerLabel, subject }) {
  await pool.query(
    `INSERT INTO followup_email_log (user_id, email_type, trigger_ref, trigger_label, subject)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, emailType, triggerRef, triggerLabel, subject]
  );
}

module.exports = {
  getEmailTypes, getUserPrefs, upsertUserPrefs, getRecentLogs,
  getProUsersWithPrefs, getIncompleteTasksDue, getActiveStreakRoutines,
  getWeeklyStats, getPastDueTasks, alreadySentToday, alreadySentThisWeek, logSent,
};
