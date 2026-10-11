'use strict';
/**
 * ai_usage_daily: per-user AI calls and tokens per UTC day.
 */

/** Count one AI call for the user today; returns today's total after counting. */
async function incrementAiCalls(pool, userId) {
  const { rows } = await pool.query(`
    INSERT INTO ai_usage_daily (user_id, usage_date, calls)
    VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET calls = ai_usage_daily.calls + 1, updated_at = NOW()
    RETURNING calls`, [userId]);
  return rows[0].calls;
}

async function addAiTokens(pool, userId, inputTokens, outputTokens) {
  await pool.query(`
    UPDATE ai_usage_daily
    SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3, updated_at = NOW()
    WHERE user_id = $1 AND usage_date = (NOW() AT TIME ZONE 'UTC')::date`,
    [userId, inputTokens || 0, outputTokens || 0]);
}

module.exports = { incrementAiCalls, addAiTokens };
