'use strict';
/**
 * routes/push-tokens.js — APNs device token registration for iOS (Capacitor) users.
 * Owns: POST /api/push/register, DELETE /api/push/unregister.
 * Does NOT own: Web Push / VAPID subscriptions (routes/notifications.js owns those),
 *               APNs send logic (lib/apns-sender.js owns that).
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  upsertPushToken,
  getPushTokens,
  deleteAllPushTokens,
} = require('../db/push-tokens');

function createPushTokensRouter(pool) {

  /**
   * POST /api/push/register
   * Store an APNs device token for the authenticated user.
   * Body: { token: string, platform: 'ios' }
   * Called by the iOS app immediately after Capacitor grants push permissions.
   */
  router.post('/register', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { token, platform } = req.body;

      if (!token || typeof token !== 'string' || token.length < 10) {
        return res.status(400).json({ success: false, message: 'Invalid token' });
      }

      // Only 'ios' supported now; guard against future misuse
      const normalizedPlatform = platform === 'ios' ? 'ios' : 'ios';

      await upsertPushToken(pool, userId, token.trim(), normalizedPlatform);

      res.json({ success: true, message: 'Push token registered' });
    } catch (err) {
      console.error('[PushTokens] Register error:', err);
      res.status(500).json({ success: false, message: 'Failed to register push token' });
    }
  });

  /**
   * DELETE /api/push/unregister
   * Remove all APNs tokens for this user (logout / disable notifications).
   */
  router.delete('/unregister', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      await deleteAllPushTokens(pool, userId);
      res.json({ success: true, message: 'Push tokens removed' });
    } catch (err) {
      console.error('[PushTokens] Unregister error:', err);
      res.status(500).json({ success: false, message: 'Failed to unregister push tokens' });
    }
  });

  /**
   * GET /api/push/status
   * Returns whether this user has any registered APNs tokens.
   * Used by the client to show/hide notification permission UI.
   */
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const tokens = await getPushTokens(pool, userId);
      res.json({
        success: true,
        registered: tokens.length > 0,
        platform: tokens.length > 0 ? tokens[0].platform : null,
      });
    } catch (err) {
      console.error('[PushTokens] Status error:', err);
      res.status(500).json({ success: false, message: 'Failed to get push status' });
    }
  });

  return router;
}

module.exports = createPushTokensRouter;
