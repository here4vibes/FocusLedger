'use strict';
/**
 * Queries for the Tandem weekly recap (lib/tandem-recap.js).
 */

const USER_COLS = (alias) => `
  ${alias}.id, ${alias}.email, ${alias}.name, ${alias}.timezone,
  COALESCE(${alias}.is_qa_user, false) AS is_qa_user,
  EXISTS (
    SELECT 1 FROM user_email_preferences uep
    WHERE uep.user_id = ${alias}.id
      AND LOWER(TRIM(uep.weekly_nudge::text)) IN ('false', 'f', '0', 'no', 'off')
  ) AS opted_out`;

/** Active partnerships with both people's contact + preference fields. */
async function getActivePartnerPairs(pool) {
  const { rows } = await pool.query(`
    SELECT p.id,
           row_to_json(a) AS a,
           row_to_json(b) AS b
    FROM partnerships p
    JOIN LATERAL (SELECT ${USER_COLS('u')} FROM users u WHERE u.id = p.inviter_id) a ON true
    JOIN LATERAL (SELECT ${USER_COLS('u')} FROM users u WHERE u.id = p.invitee_id) b ON true
    WHERE p.status = 'active' AND p.inviter_id IS NOT NULL AND p.invitee_id IS NOT NULL`);
  return rows;
}

async function wasSentOnLocalDate(pool, userId, templateType, tz, localDate) {
  const { rows } = await pool.query(`
    SELECT 1 FROM email_log
    WHERE user_id = $1 AND template_type = $2
      AND (created_at AT TIME ZONE $3)::date = $4::date
    LIMIT 1`, [userId, templateType, tz, localDate]);
  return rows.length > 0;
}

/**
 * Last 7 days: tasks either partner finished (one combined number) and the
 * titles of shared/household ones (already visible to both).
 */
async function getWeekTogether(pool, meId, themId) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)::int AS together,
      COALESCE(
        json_agg(title ORDER BY completed_at DESC)
          FILTER (WHERE COALESCE(is_household, false) OR COALESCE(is_shared_with_partner, false)),
        '[]'::json
      ) AS shared_wins
    FROM tasks
    WHERE user_id = ANY($1::int[])
      AND is_completed = true
      AND completed_at >= NOW() - INTERVAL '7 days'`, [[meId, themId]]);
  const r = rows[0] || {};
  return { together: r.together || 0, sharedWins: (r.shared_wins || []).filter(Boolean) };
}

module.exports = { getActivePartnerPairs, wasSentOnLocalDate, getWeekTogether };
