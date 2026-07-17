'use strict';
/**
 * lib/webpush.js — single source of truth for push configuration.
 *
 * WHY: every cron used to re-implement this setup inline. Each copy could
 * independently rot — an untrimmed VAPID key (pasted with a trailing newline)
 * made setVapidDetails throw and SILENTLY disabled push, and a bare early-return
 * left a run "finishing successfully" with zero output while nothing sent. That
 * cost days of blind debugging across notifications that never fired.
 *
 * One helper now owns it: trims the keys, logs the exact reason push is or isn't
 * available (tagged with the job name), and never fails silently. Callers get a
 * ready-to-use webpush handle (or null) plus flags — no per-cron setup, no drift.
 */
const { isApnsConfigured } = require('./apns-sender');

/**
 * @param {string} jobLabel — short job name for log lines, e.g. 'morning-nudge'.
 * @returns {{ webpush: object|null, apnsEnabled: boolean, webPushEnabled: boolean, anyConfigured: boolean }}
 */
function configureWebPush(jobLabel) {
  const tag = `[${jobLabel}]`;
  const webPushEnabled = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  const apnsEnabled = isApnsConfigured();

  if (!webPushEnabled && !apnsEnabled) {
    console.warn(`${tag} No push channel configured — set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (web push) or APNS_KEY_ID/APNS_TEAM_ID/APNS_KEY_P8/APNS_BUNDLE_ID (iOS) in the cron env group. Skipping (0 sent).`);
    return { webpush: null, apnsEnabled: false, webPushEnabled: false, anyConfigured: false };
  }

  let webpush = null;
  if (webPushEnabled) {
    try {
      webpush = require('web-push');
      // Trim: pasted env values routinely carry a trailing newline/space, which
      // makes setVapidDetails throw "Vapid public key should be 65 bytes".
      webpush.setVapidDetails(
        'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
        (process.env.VAPID_PUBLIC_KEY || '').trim(),
        (process.env.VAPID_PRIVATE_KEY || '').trim()
      );
      console.log(`${tag} Web push configured (VAPID ok).`);
    } catch (e) {
      webpush = null;
      console.error(`${tag} Web push DISABLED despite VAPID env being set —`, e.message,
        '| malformed key (trailing whitespace/newline?) or web-push not installed.');
    }
  }

  return { webpush, apnsEnabled, webPushEnabled, anyConfigured: !!(webpush || apnsEnabled) };
}

module.exports = { configureWebPush };
