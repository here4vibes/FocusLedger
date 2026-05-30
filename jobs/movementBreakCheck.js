/**
 * jobs/movementBreakCheck.js — Scheduled job (every 15 min via polsia.toml).
 * Finds active focus sessions that have run longer than the user's
 * break_interval_minutes and sends a movement break nudge.
 *
 * Does NOT own: nudge delivery, push, Buddy panel.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const { generateMovementBreakNudge } = require('../lib/nudgeGenerator');

async function run() {
  console.log('[MovementBreakCheck] Starting check…');

  try {
    // Find active sessions where:
    // - Session has no ended_at (still running)
    // - started_at was more than break_interval_minutes ago
    // Use a single query with join to avoid N+1 problem.
    const result = await pool.query(`
      SELECT
        fs.id           AS session_id,
        fs.user_id,
        fs.started_at,
        ufp.break_interval_minutes
      FROM focus_sessions fs
      JOIN user_focus_prefs ufp ON ufp.user_id = fs.user_id
      WHERE fs.ended_at IS NULL
        AND fs.started_at < NOW() - (ufp.break_interval_minutes || ' minutes')::interval
    `);

    let created = 0;

    for (const row of result.rows) {
      try {
        const { created: ok } = await generateMovementBreakNudge(
          pool,
          row.user_id,
          row.session_id
        );
        if (ok) {
          created++;
          console.log(
            `[MovementBreakCheck] Nudge sent for session ${row.session_id} (user ${row.user_id})`
          );
        }
      } catch (err) {
        console.error(
          `[MovementBreakCheck] Error for session ${row.session_id}:`,
          err.message
        );
      }
    }

    console.log(`[MovementBreakCheck] Done. Nudges created: ${created}`);
  } catch (err) {
    console.error('[MovementBreakCheck] Fatal error:', err);
  } finally {
    await pool.end();
  }
}

run();