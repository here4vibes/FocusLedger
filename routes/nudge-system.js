// Owns: nudge CRUD + preference management endpoints.
// Does NOT own: nudge generation logic (lib/nudgeGenerator.js), push subscriptions (notifications.js),
//               or buddy check-in flow (buddy.js).
//
// Endpoints:
//   GET    /api/nudge-system/pending        — pending nudges for authenticated user
//   POST   /api/nudge-system/dismiss/:id   — mark a nudge dismissed
//   POST   /api/nudge-system/acted/:id     — mark a nudge acted_on
//   GET    /api/nudge-system/preferences   — get delivery channel preferences
//   PUT    /api/nudge-system/preferences   — update delivery channel preferences
//   POST   /api/nudge-system/generate      — trigger nudge generation for current user

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { generateNudgesForUser, getPendingNudgesForUser } = require('../lib/nudgeGenerator');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── GET /api/nudge-system/pending ────────────────────────────────────────
  // Returns pending nudges for the current user.
  // Optionally delivers push notifications if push_enabled preference is set.
  router.get('/pending', async (req, res) => {
    try {
      const userId = req.user.id;
      const nudges = await getPendingNudgesForUser(pool, userId);

      // Mark nudges as delivered
      if (nudges.length > 0) {
        const ids = nudges.map(n => n.id);
        await pool.query(`
          UPDATE nudges
          SET status = 'delivered', delivered_at = NOW()
          WHERE id = ANY($1) AND status = 'pending'
        `, [ids]).catch(() => {});
      }

      // Send push notifications if user has push enabled
      const prefsResult = await pool.query(`
        SELECT push_enabled FROM nudge_preferences WHERE user_id = $1
      `, [userId]);

      const pushEnabled = prefsResult.rows.length === 0
        ? true  // default: push on
        : prefsResult.rows[0].push_enabled;

      if (pushEnabled && nudges.length > 0) {
        // Fire-and-forget push — don't block the response
        sendPushForNudges(pool, userId, nudges).catch(() => {});
      }

      res.json({ success: true, nudges });
    } catch (err) {
      console.error('[nudge-system] GET /pending error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load nudges' });
    }
  });

  // ─── POST /api/nudge-system/dismiss/:id ──────────────────────────────────
  router.post('/dismiss/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const nudgeId = parseInt(req.params.id, 10);

      const result = await pool.query(`
        UPDATE nudges
        SET status = 'dismissed', dismissed_at = NOW()
        WHERE id = $1 AND user_id = $2
          AND status IN ('pending', 'delivered')
        RETURNING id
      `, [nudgeId, userId]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Nudge not found' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[nudge-system] POST /dismiss error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to dismiss nudge' });
    }
  });

  // ─── POST /api/nudge-system/acted/:id ────────────────────────────────────
  router.post('/acted/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const nudgeId = parseInt(req.params.id, 10);

      const result = await pool.query(`
        UPDATE nudges
        SET status = 'acted_on'
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `, [nudgeId, userId]);

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'Nudge not found' });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[nudge-system] POST /acted error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update nudge' });
    }
  });

  // ─── GET /api/nudge-system/preferences ───────────────────────────────────
  router.get('/preferences', async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT push_enabled, buddy_enabled, email_enabled, banner_enabled
        FROM nudge_preferences
        WHERE user_id = $1
      `, [userId]);

      // Defaults: push + buddy enabled, email + banner off
      const prefs = result.rows[0] || {
        push_enabled: true,
        buddy_enabled: true,
        email_enabled: false,
        banner_enabled: false
      };

      res.json({ success: true, preferences: prefs });
    } catch (err) {
      console.error('[nudge-system] GET /preferences error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load preferences' });
    }
  });

  // ─── PUT /api/nudge-system/preferences ───────────────────────────────────
  router.put('/preferences', async (req, res) => {
    try {
      const userId = req.user.id;
      const { push_enabled, buddy_enabled, email_enabled, banner_enabled } = req.body;

      // Upsert: insert defaults, then update only provided fields
      await pool.query(`
        INSERT INTO nudge_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);

      const fields = [];
      const values = [];
      let idx = 1;

      if (typeof push_enabled === 'boolean')   { fields.push(`push_enabled = $${idx++}`);   values.push(push_enabled); }
      if (typeof buddy_enabled === 'boolean')  { fields.push(`buddy_enabled = $${idx++}`);  values.push(buddy_enabled); }
      if (typeof email_enabled === 'boolean')  { fields.push(`email_enabled = $${idx++}`);  values.push(email_enabled); }
      if (typeof banner_enabled === 'boolean') { fields.push(`banner_enabled = $${idx++}`); values.push(banner_enabled); }

      if (fields.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid fields to update' });
      }

      fields.push(`updated_at = NOW()`);
      values.push(userId);

      await pool.query(
        `UPDATE nudge_preferences SET ${fields.join(', ')} WHERE user_id = $${idx}`,
        values
      );

      res.json({ success: true });
    } catch (err) {
      console.error('[nudge-system] PUT /preferences error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
  });

  // ─── GET /api/nudge-system/feed ──────────────────────────────────────────
  // Returns all nudges for the feed page: pending first, then recent dismissed.
  // Max 90 days lookback to keep the list manageable.
  router.get('/feed', async (req, res) => {
    try {
      const userId = req.user.id;

      const result = await pool.query(`
        SELECT id, type, source_type, source_id, message, urgency, status,
               created_at, action_url, action_label, dismissed_at, delivered_at
        FROM nudges
        WHERE user_id = $1
          AND created_at > NOW() - INTERVAL '90 days'
        ORDER BY
          CASE status WHEN 'pending' THEN 0 WHEN 'delivered' THEN 1 ELSE 2 END ASC,
          CASE urgency WHEN 'urgent' THEN 0 ELSE 1 END ASC,
          created_at DESC
        LIMIT 100
      `, [userId]);

      res.json({ success: true, nudges: result.rows });
    } catch (err) {
      console.error('[nudge-system] GET /feed error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load nudge feed' });
    }
  });

  // ─── POST /api/nudge-system/generate ─────────────────────────────────────
  // Triggers nudge generation for the current user (e.g., after uploading a doc).
  // Fire-and-forget on the client side — returns immediately.
  router.post('/generate', async (req, res) => {
    try {
      const userId = req.user.id;
      // Respond immediately, generate in background
      res.json({ success: true });
      await generateNudgesForUser(pool, userId);
    } catch (err) {
      console.error('[nudge-system] POST /generate error:', err.message);
    }
  });

  return router;
};

// ── Internal: send push notifications for nudge delivery ─────────────────────
// Wraps the existing notification system with nudge-specific payloads.
// Includes dedup via notification_send_log + daily cap to prevent duplicate sends.
async function sendPushForNudges(pool, userId, nudges) {
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
    return;
  }

  try {
    // Check daily cap
    const todayCount = await getTodayNotificationCount(pool, userId);
    if (todayCount >= DAILY_PUSH_CAP) return;

    // Dedup: skip nudges already sent today
    const key = `life-nudge:${new Date().toISOString().slice(0, 13)}`; // hourly granularity
    const alreadySent = await wasNotificationSentToday(pool, userId, key);
    if (alreadySent) return;

    const subscriptions = await getActiveSubscriptions(pool, userId);
    if (!subscriptions.length) return;

    // Use the most urgent nudge as the notification body
    const urgentNudge = nudges.find(n => n.urgency === 'urgent') || nudges[0];
    // WHY renotify: false — prevents browser from re-alerting if same tag already shown
    const payload = JSON.stringify({
      title: 'FocusLedger',
      body: urgentNudge.message,
      url: '/app/life',
      tag: 'fl-life-nudge',
      renotify: false
    });

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
          await deleteSubscriptionByEndpoint(pool, row.endpoint).catch(() => {});
        }
      }
    }

    if (sentCount > 0) {
      await recordNotificationSent(pool, userId, key, 'life_nudge');
    }
  } catch (err) {
    console.error('[nudge-system] sendPushForNudges error:', err.message);
  }
}
