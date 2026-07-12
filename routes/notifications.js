const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

function createNotificationsRouter(pool) {

  // Lazy-load web-push to avoid startup crash if not installed yet
  function getWebPush() {
    try {
      const webpush = require('web-push');
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        webpush.setVapidDetails(
          'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
          process.env.VAPID_PUBLIC_KEY,
          process.env.VAPID_PRIVATE_KEY
        );
        return webpush;
      }
      return null;
    } catch {
      return null;
    }
  }

  // GET /api/notifications/vapid-public-key
  // Returns the VAPID public key so the client can subscribe to push
  router.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY || null;
    res.json({
      success: true,
      key,
      enabled: !!key
    });
  });

  // POST /api/notifications/subscribe
  // Save a push subscription for the authenticated user.
  // Optional body fields: { subscription, timezone }
  // timezone: IANA timezone string (e.g. "America/New_York") — saved to users.timezone
  router.post('/subscribe', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { subscription, timezone } = req.body;

      if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ success: false, message: 'Invalid subscription object' });
      }

      const endpoint = subscription.endpoint;
      const subJson = JSON.stringify(subscription);

      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, subscription, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id, endpoint)
         DO UPDATE SET subscription = $3, enabled = true, updated_at = NOW()`,
        [userId, endpoint, subJson]
      );

      // WHY: limit to 3 active subscriptions per user. Users can accumulate stale
      // subscriptions when they clear browser data (new endpoint generated) or switch
      // devices. Each stale sub still receives push, causing duplicate notifications.
      // Keep only the 3 most recently updated; delete the rest.
      await pool.query(
        `DELETE FROM push_subscriptions
         WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM push_subscriptions
           WHERE user_id = $1 AND enabled = true
           ORDER BY updated_at DESC NULLS LAST
           LIMIT 3
         )`,
        [userId]
      ).catch(e => console.warn('[notifications] cleanup old subs:', e.message));

      // Save timezone so nudges fire at local times
      if (timezone && typeof timezone === 'string' && timezone.length < 64) {
        await pool.query(
          'UPDATE users SET timezone = $1 WHERE id = $2',
          [timezone, userId]
        ).catch(e => console.warn('[notifications] timezone update:', e.message));
      }

      // Send a confirmation notification
      const webpush = getWebPush();
      if (webpush) {
        try {
          await webpush.sendNotification(
            subscription,
            JSON.stringify({
              title: 'Notifications on \u2713',
              body: "You\u2019ll get a morning nudge at 8am and an evening check-in at 8pm. Change times anytime in Settings.",
              url: '/settings',
              tag: 'fl-welcome'
            })
          );
        } catch (pushErr) {
          // Not fatal — subscription saved, welcome notif failed
          console.warn('[Notifications] Welcome push failed:', pushErr.message);
        }
      }

      res.json({ success: true, message: 'Subscribed to push notifications' });
    } catch (err) {
      console.error('[Notifications] Subscribe error:', err);
      res.status(500).json({ success: false, message: 'Failed to save subscription' });
    }
  });

  // PUT /api/notifications/timezone
  // Update the user's stored timezone for nudge scheduling.
  router.put('/timezone', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { timezone } = req.body;
      if (!timezone || typeof timezone !== 'string' || timezone.length >= 64) {
        return res.status(400).json({ success: false, message: 'Invalid timezone' });
      }
      await pool.query('UPDATE users SET timezone = $1 WHERE id = $2', [timezone, userId]);
      res.json({ success: true });
    } catch (err) {
      console.error('[Notifications] Timezone update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update timezone' });
    }
  });

  // DELETE /api/notifications/unsubscribe
  // Remove all push subscriptions for the authenticated user
  router.delete('/unsubscribe', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      await pool.query(
        'DELETE FROM push_subscriptions WHERE user_id = $1',
        [userId]
      );
      res.json({ success: true, message: 'Unsubscribed from push notifications' });
    } catch (err) {
      console.error('[Notifications] Unsubscribe error:', err);
      res.status(500).json({ success: false, message: 'Failed to remove subscription' });
    }
  });

  // POST /api/notifications/test
  // Send a test push to the caller's own devices — end-to-end verification
  // (VAPID signing + subscription + service worker) without waiting for a cron.
  router.post('/test', authenticateToken, async (req, res) => {
    try {
      const { sendPushToUser } = require('../lib/sendPushToUser');
      await sendPushToUser(pool, req.user.id, {
        title: 'Buddy here 👋',
        body: 'Test received. The pipes are connected — see you in the morning.',
        url: '/app',
      });
      res.json({ success: true, message: 'Test push sent — check your notifications.' });
    } catch (err) {
      console.error('[Notifications] test push failed:', err.message, '| userId:', req.user?.id);
      res.status(500).json({ success: false, message: 'Test push failed' });
    }
  });

  // GET /api/notifications/status
  // Check if the current user has push subscriptions + return their prefs
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      const [subResult, prefsResult] = await Promise.all([
        pool.query(
          'SELECT COUNT(*) as count FROM push_subscriptions WHERE user_id = $1 AND enabled = true',
          [userId]
        ),
        pool.query(
          `SELECT
             COALESCE(notif_morning_enabled, true)  AS notif_morning_enabled,
             COALESCE(notif_evening_enabled, true)  AS notif_evening_enabled,
             COALESCE(notif_morning_hour, 8)         AS notif_morning_hour,
             COALESCE(notif_evening_hour, 20)        AS notif_evening_hour,
             COALESCE(timezone, '')                  AS timezone
           FROM users WHERE id = $1`,
          [userId]
        )
      ]);

      const subscribed = parseInt(subResult.rows[0].count) > 0;
      const vapidEnabled = !!process.env.VAPID_PUBLIC_KEY;
      const prefs = prefsResult.rows[0] || {
        notif_morning_enabled: true,
        notif_evening_enabled: true,
        notif_morning_hour: 8,
        notif_evening_hour: 20,
        timezone: ''
      };

      res.json({
        success: true,
        subscribed,
        vapidEnabled,
        pushSupported: vapidEnabled,
        prefs: {
          morningEnabled: prefs.notif_morning_enabled,
          eveningEnabled: prefs.notif_evening_enabled,
          morningHour: parseInt(prefs.notif_morning_hour, 10),
          eveningHour: parseInt(prefs.notif_evening_hour, 10),
          timezone: prefs.timezone
        }
      });
    } catch (err) {
      console.error('[Notifications] Status error:', err);
      res.status(500).json({ success: false, message: 'Failed to get notification status' });
    }
  });

  // PUT /api/notifications/preferences
  // Update morning/evening notification toggles and send times
  // Body: { morningEnabled, eveningEnabled, morningHour, eveningHour }
  router.put('/preferences', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { morningEnabled, eveningEnabled, morningHour, eveningHour } = req.body;

      // Validate hours (0-23)
      const mHour = Number.isInteger(morningHour) && morningHour >= 0 && morningHour <= 23
        ? morningHour : null;
      const eHour = Number.isInteger(eveningHour) && eveningHour >= 0 && eveningHour <= 23
        ? eveningHour : null;

      const updates = [];
      const values = [];
      let idx = 1;

      if (typeof morningEnabled === 'boolean') {
        updates.push(`notif_morning_enabled = $${idx++}`);
        values.push(morningEnabled);
      }
      if (typeof eveningEnabled === 'boolean') {
        updates.push(`notif_evening_enabled = $${idx++}`);
        values.push(eveningEnabled);
      }
      if (mHour !== null) {
        updates.push(`notif_morning_hour = $${idx++}`);
        values.push(mHour);
      }
      if (eHour !== null) {
        updates.push(`notif_evening_hour = $${idx++}`);
        values.push(eHour);
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid fields to update' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(userId);

      await pool.query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`,
        values
      );

      res.json({ success: true });
    } catch (err) {
      console.error('[Notifications] Preferences update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
  });

  return router;
}

/**
 * sendNudgePushNotifications(pool, userId, nudges)
 * Sends browser push notifications with dedup + daily cap.
 * Checks notification_send_log before sending to prevent duplicates.
 * Respects a daily cap of 3 push notifications per user.
 */
async function sendNudgePushNotifications(pool, userId, nudges) {
  if (!nudges || nudges.length === 0) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  const {
    DAILY_PUSH_CAP,
    getTodayNotificationCount,
    wasNotificationSentToday,
    recordNotificationSent,
    getActiveSubscriptions,
    deleteSubscriptionByEndpoint,
  } = require('../db/notifications');

  let webpush;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:' + (process.env.VAPID_EMAIL || 'support@focusledger.app'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch {
    return; // web-push not installed yet, skip silently
  }

  try {
    // Check daily cap — bail early if user already hit the limit
    const todayCount = await getTodayNotificationCount(pool, userId);
    if (todayCount >= DAILY_PUSH_CAP) return;

    // Filter out nudges already sent today
    const unsentNudges = [];
    for (const nudge of nudges) {
      const key = nudge.id ? `task:${nudge.id}` : `nudge:${nudge.type}`;
      const alreadySent = await wasNotificationSentToday(pool, userId, key);
      if (!alreadySent) unsentNudges.push(nudge);
    }
    if (unsentNudges.length === 0) return;

    // Respect remaining cap
    const remaining = DAILY_PUSH_CAP - todayCount;
    const toSend = unsentNudges.slice(0, remaining);

    const subscriptions = await getActiveSubscriptions(pool, userId);
    if (subscriptions.length === 0) return;

    // Build notification payload
    const overdueCount = toSend.filter(n => n.type === 'overdue').length;
    const urgentCount = toSend.filter(n => n.type === '1h').length;
    const totalCount = toSend.length;

    // De Botton: no alarm, no shame. Gentle reframe — "still waiting" not "OVERDUE".
    const title = 'FocusLedger';
    let body;
    if (overdueCount > 0) {
      body = overdueCount === 1
        ? `"${toSend.find(n => n.type === 'overdue').title}" \u2014 still waiting`
        : `${overdueCount} things are still waiting`;
    } else if (urgentCount > 0) {
      body = urgentCount === 1
        ? `"${toSend.find(n => n.type === '1h').title}" \u2014 almost time`
        : `${urgentCount} things coming up soon`;
    } else {
      body = totalCount === 1
        ? `"${toSend[0].title}" \u2014 on the list for today`
        : `${totalCount} things on today\u2019s list`;
    }

    // WHY renotify: false — prevents browser from re-alerting if same tag already shown.
    // The tag 'fl-nudge' means browser silently replaces the previous notification.
    const payload = JSON.stringify({ title, body, url: '/app/tasks', tag: 'fl-nudge', renotify: false });

    let sentCount = 0;
    for (const row of subscriptions) {
      try {
        const sub = typeof row.subscription === 'string'
          ? JSON.parse(row.subscription)
          : row.subscription;
        await webpush.sendNotification(sub, payload);
        sentCount++;
      } catch (sendErr) {
        if (sendErr.statusCode === 410 || sendErr.statusCode === 404) {
          await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(e => console.warn('[notifications] cleanup stale sub:', e.message));
        } else {
          console.warn('[Notifications] Push send error:', sendErr.message);
        }
      }
    }

    // Record all sent notifications to prevent re-sending
    if (sentCount > 0) {
      for (const nudge of toSend) {
        const key = nudge.id ? `task:${nudge.id}` : `nudge:${nudge.type}`;
        await recordNotificationSent(pool, userId, key, 'task_nudge');
      }
    }
  } catch (err) {
    console.error('[Notifications] sendNudgePushNotifications error:', err);
  }
}

module.exports = createNotificationsRouter;
module.exports.sendNudgePushNotifications = sendNudgePushNotifications;
