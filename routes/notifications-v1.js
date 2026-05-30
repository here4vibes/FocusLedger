'use strict';
/**
 * routes/notifications-v1.js — Notification preferences API (v1).
 * Mounts at /api/v1/notifications (server.js wires this).
 *
 * Owns: GET/PATCH /api/v1/notifications/preferences.
 * Does NOT own: push delivery (services/NotificationService.js),
 *               push subscriptions (routes/notifications.js).
 *
 * Uses user_notification_prefs table (from shared_services_p1 migration)
 * vs old routes/notifications.js which uses users table columns.
 */

const express = require('express');
const router  = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { get_preferences, update_preferences } = require('../services/NotificationService');

// GET /api/v1/notifications/preferences
router.get('/preferences', authenticateToken, async (req, res) => {
  try {
    const prefs = await get_preferences(req.pool, req.user.id);
    res.json(prefs);
  } catch (err) {
    console.error('[notifications-v1] GET prefs error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/v1/notifications/preferences
router.patch('/preferences', authenticateToken, async (req, res) => {
  const { evening_enabled, evening_time } = req.body || {};

  if (evening_time !== undefined) {
    // Accept HH:MM or HH:MM:SS
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
    if (!timeRegex.test(evening_time)) {
      return res.status(400).json({ error: 'evening_time must be HH:MM or HH:MM:SS' });
    }
  }
  if (evening_enabled !== undefined && typeof evening_enabled !== 'boolean') {
    return res.status(400).json({ error: 'evening_enabled must be a boolean' });
  }

  try {
    await update_preferences(req.pool, req.user.id, { evening_enabled, evening_time });
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications-v1] PATCH prefs error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
