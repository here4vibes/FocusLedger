'use strict';
/**
 * lib/sendPushToUser.js — Fire a push notification to a specific authenticated user.
 * Tries Web Push (VAPID) first, then APNs. Best-effort: never throws.
 * Used by routes that need real-time pushes (e.g. routine completion triggers).
 */

const { sendApnsNotification, isApnsConfigured } = require('./apns-sender');
const { getPushTokens, deletePushToken } = require('../db/push-tokens');

/**
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ title: string, body: string, url?: string }} payload
 */
async function sendPushToUser(pool, userId, { title, body, url = '/' }) {
  try {
    // ── Web Push (VAPID) ───────────────────────────────────────────────────────
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      let webpush;
      try { webpush = require('web-push'); } catch { /* not installed */ }
      if (webpush) {
        webpush.setVapidDetails(
          'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
          process.env.VAPID_PUBLIC_KEY,
          process.env.VAPID_PRIVATE_KEY
        );
        const { rows } = await pool.query(
          `SELECT endpoint, subscription FROM push_subscriptions
           WHERE user_id = $1 AND enabled = true`,
          [userId]
        );
        for (const row of rows) {
          try {
            const sub = typeof row.subscription === 'string'
              ? JSON.parse(row.subscription)
              : row.subscription;
            await webpush.sendNotification(sub, JSON.stringify({ title, body, url }));
          } catch (e) {
            if (e.statusCode === 410 || e.statusCode === 404) {
              await pool.query(
                `UPDATE push_subscriptions SET enabled = false WHERE endpoint = $1`,
                [row.endpoint]
              ).catch(() => {});
            }
          }
        }
      }
    }

    // ── APNs ───────────────────────────────────────────────────────────────────
    if (isApnsConfigured()) {
      const tokenRows = await getPushTokens(pool, userId);
      if (tokenRows.length) {
        const tokens = tokenRows.map(r => r.token);
        await sendApnsNotification(tokens, { title, body, url }, async (badToken) => {
          await deletePushToken(pool, badToken).catch(() => {});
        });
      }
    }
  } catch { /* silent — push is best-effort */ }
}

module.exports = { sendPushToUser };
