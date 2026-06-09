'use strict';
/**
 * lib/apns-sender.js — Apple Push Notification Service sender.
 * Wraps the `apn` npm package. Only active when APNS_* env vars are set.
 * WHY isolated: lets server start cleanly in envs without APNs credentials.
 */

function isApnsConfigured() {
  return !!(
    process.env.APNS_KEY_ID &&
    process.env.APNS_TEAM_ID &&
    process.env.APNS_KEY_P8 &&
    process.env.APNS_BUNDLE_ID
  );
}

/**
 * Send a push notification to one or more APNs device tokens.
 * @param {string[]} tokens
 * @param {{ title: string, body: string, url?: string }} payload
 * @param {(invalidToken: string) => void} onInvalidToken — called for 410/BadDeviceToken errors
 * @returns {Promise<{ sent: number, failed: number }>}
 */
async function sendApnsNotification(tokens, payload, onInvalidToken) {
  if (!isApnsConfigured()) return { sent: 0, failed: 0 };

  let apn;
  try {
    apn = require('apn');
  } catch {
    return { sent: 0, failed: 0 };
  }

  const provider = new apn.Provider({
    token: {
      key: Buffer.from(process.env.APNS_KEY_P8, 'base64').toString('utf8'),
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    },
    production: process.env.NODE_ENV === 'production',
  });

  const note = new apn.Notification();
  note.alert = { title: payload.title, body: payload.body };
  note.topic = process.env.APNS_BUNDLE_ID;
  note.payload = { url: payload.url };
  note.expiry = Math.floor(Date.now() / 1000) + 3600;

  let sent = 0;
  let failed = 0;

  for (const token of tokens) {
    try {
      const result = await provider.send(note, token);
      if (result.failed && result.failed.length > 0) {
        const err = result.failed[0];
        if (err.response?.reason === 'BadDeviceToken' || err.status === '410') {
          if (onInvalidToken) onInvalidToken(token);
        }
        failed++;
      } else {
        sent++;
      }
    } catch {
      failed++;
    }
  }

  provider.shutdown();
  return { sent, failed };
}

module.exports = { isApnsConfigured, sendApnsNotification };
