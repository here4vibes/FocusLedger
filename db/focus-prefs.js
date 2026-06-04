'use strict';

const DEFAULTS = {
  body_double_enabled:   false,
  ambient_style:         'cafe',
  ambient_volume:        50,
  break_interval_minutes: 90,
};

async function getFocusPrefs(pool, userId) {
  const { rows } = await pool.query(
    `SELECT body_double_enabled, ambient_style, ambient_volume, break_interval_minutes
     FROM user_focus_prefs WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || { ...DEFAULTS };
}

async function upsertFocusPrefs(pool, userId, {
  bodyDoubleEnabled,
  ambientStyle,
  ambientVolume,
  breakIntervalMinutes,
} = {}) {
  const { rows } = await pool.query(
    `INSERT INTO user_focus_prefs (user_id, body_double_enabled, ambient_style, ambient_volume, break_interval_minutes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       body_double_enabled    = COALESCE($2, user_focus_prefs.body_double_enabled),
       ambient_style          = COALESCE($3, user_focus_prefs.ambient_style),
       ambient_volume         = COALESCE($4, user_focus_prefs.ambient_volume),
       break_interval_minutes = COALESCE($5, user_focus_prefs.break_interval_minutes),
       updated_at             = NOW()
     RETURNING body_double_enabled, ambient_style, ambient_volume, break_interval_minutes`,
    [
      userId,
      bodyDoubleEnabled !== undefined ? bodyDoubleEnabled : null,
      ambientStyle      !== undefined ? ambientStyle      : null,
      ambientVolume     !== undefined ? ambientVolume     : null,
      breakIntervalMinutes !== undefined ? breakIntervalMinutes : null,
    ]
  );
  return rows[0] || { ...DEFAULTS };
}

module.exports = { getFocusPrefs, upsertFocusPrefs };
