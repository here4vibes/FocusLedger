/**
 * jobs/impulseSpendingCheck.js — Scheduled job (every 15 min via polsia.toml).
 * Evaluates spending patterns for all active users and creates proactive alerts
 * when impulse spending trends are detected.
 *
 * Does NOT own: alert delivery, UI, notification scheduling
 * (delivery is handled by the Money page polling /api/expenses/alerts).
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const {
  getWeeklySpendingStats,
  upsertImpulseAlert,
  getActiveAlerts,
} = require('../db/impulseNudges');
const { buildSpendingAlert } = require('../lib/impulseNudgeEngine');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

async function run() {
  console.log('[ImpulseSpendingCheck] Starting check…');

  try {
    // Get all users who have expenses (active spenders)
    const users = await pool.query(`
      SELECT DISTINCT user_id
      FROM expenses
      WHERE expense_date >= CURRENT_DATE - INTERVAL '7 days'
    `);

    let alertsCreated = 0;

    for (const { user_id: userId } of users.rows) {
      try {
        const tz = await fetchUserTimezone(pool, userId);
        if (!tz) continue;

        const localDate = getUserLocalDate(tz);

        // Skip if we already have an active alert today
        const existing = await getActiveAlerts(pool, userId);
        if (existing.length > 0) continue;

        const stats = await getWeeklySpendingStats(pool, userId, localDate);
        if (stats.total_count === 0) continue;

        // Only alert if they have meaningful spend (> $50 this week)
        if (stats.total_spent < 50) continue;

        const alert = buildSpendingAlert(stats);
        if (!alert) continue;

        await upsertImpulseAlert(pool, userId, alert.alertType, localDate, alert.message);
        alertsCreated++;
        console.log(`[ImpulseSpendingCheck] Created alert for user ${userId}: ${alert.alertType}`);
      } catch (err) {
        console.error(`[ImpulseSpendingCheck] Error processing user ${userId}:`, err.message);
      }
    }

    console.log(`[ImpulseSpendingCheck] Done. Alerts created: ${alertsCreated}`);
  } catch (err) {
    console.error('[ImpulseSpendingCheck] Fatal error:', err);
  } finally {
    await pool.end();
  }
}

run();