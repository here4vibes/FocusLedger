/**
 * routes/focus-prefs.js — Body Double + Ambient Layer preferences API.
 *
 * Owns: GET/POST /api/v1/focus-preferences
 * Does NOT own: focus_sessions, task ownership
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getFocusPrefs, upsertFocusPrefs } = require('../db/focus-prefs');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/v1/focus-preferences
  // Returns stored prefs (or defaults for new users)
  router.get('/', async (req, res) => {
    try {
      const prefs = await getFocusPrefs(pool, req.user.id);
      res.json({
        body_double_enabled: prefs.body_double_enabled,
        ambient_style: prefs.ambient_style,
        ambient_volume: prefs.ambient_volume,
        break_interval_minutes: prefs.break_interval_minutes,
      });
    } catch (err) {
      console.error('[focus-prefs] get error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  // POST /api/v1/focus-preferences
  // Body: { body_double_enabled?, ambient_style?, ambient_volume?, break_interval_minutes? }
  router.post('/', async (req, res) => {
    try {
      const { body_double_enabled, ambient_style, ambient_volume, break_interval_minutes } = req.body;

      if (ambient_volume !== undefined && ambient_volume !== null) {
        const vol = parseInt(ambient_volume, 10);
        if (isNaN(vol) || vol < 0 || vol > 100) {
          return res.status(400).json({
            success: false,
            message: 'ambient_volume must be an integer between 0 and 100',
          });
        }
      }
      if (ambient_style && !['cafe', 'library', 'rain', 'audio_only'].includes(ambient_style)) {
        return res.status(400).json({
          success: false,
          message: 'ambient_style must be one of: cafe, library, rain, audio_only',
        });
      }
      if (break_interval_minutes !== undefined && break_interval_minutes !== null) {
        const iv = parseInt(break_interval_minutes, 10);
        if (![45, 60, 90, 120].includes(iv)) {
          return res.status(400).json({
            success: false,
            message: 'break_interval_minutes must be one of: 45, 60, 90, 120',
          });
        }
      }

      const prefs = await upsertFocusPrefs(pool, req.user.id, {
        bodyDoubleEnabled: body_double_enabled !== undefined ? Boolean(body_double_enabled) : undefined,
        ambientStyle: ambient_style,
        ambientVolume: ambient_volume !== undefined ? ambient_volume : undefined,
        breakIntervalMinutes: break_interval_minutes !== undefined ? break_interval_minutes : undefined,
      });

      res.json({
        body_double_enabled: prefs.body_double_enabled,
        ambient_style: prefs.ambient_style,
        ambient_volume: prefs.ambient_volume,
        break_interval_minutes: prefs.break_interval_minutes,
      });
    } catch (err) {
      console.error('[focus-prefs] upsert error:', err.message);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  return router;
};