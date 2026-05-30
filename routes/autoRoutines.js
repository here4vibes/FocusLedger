// Owns: Auto-Routines API endpoints — pattern detection trigger, suggestion management.
// Does NOT own: pattern detection engine (lib/patternDetection.js),
//               buddy conversations, or suggestion UI (buddy.html).
//
// Endpoints:
//   POST /api/auto-routines/detect        — trigger pattern detection for current user
//   GET  /api/auto-routines/suggestion     — get one suggestion for Buddy session start
//   POST /api/auto-routines/suggestion/:id/accept — create routine from accepted suggestion
//   POST /api/auto-routines/suggestion/:id/dismiss — dismiss suggestion (optionally never ask again)

'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone } = require('../lib/timezone');
const {
  runPatternDetection,
  getSessionSuggestion,
  acceptSuggestion,
  dismissSuggestion
} = require('../lib/patternDetection');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── POST /api/auto-routines/detect ───────────────────────────────────────
  // Trigger pattern detection for the current user.
  // Called on app load (best-effort, non-blocking) or on-demand by user.
  // Body: none required — uses authenticated user
  router.post('/detect', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);

      // Run detection asynchronously (don't block the response)
      // Best-effort — errors are logged but don't fail the response
      const result = await runPatternDetection(pool, userId, tz);

      res.json({
        success: true,
        patternsDetected: result.detected,
        suggestionsCreated: result.suggestionsCreated
      });
    } catch (err) {
      console.error('[auto-routines] POST /detect error:', err.message);
      res.status(500).json({ success: false, message: 'Pattern detection failed' });
    }
  });

  // ─── GET /api/auto-routines/suggestion ────────────────────────────────────
  // Get the one suggestion to surface at Buddy session start.
  // Increments presented_count so ignored suggestions auto-expire after 3 sessions.
  // Called from Buddy session-status enrichment (best-effort, non-blocking).
  router.get('/suggestion', async (req, res) => {
    try {
      const userId = req.user.id;

      const suggestion = await getSessionSuggestion(pool, userId);

      if (!suggestion) {
        return res.json({ success: true, suggestion: null });
      }

      res.json({
        success: true,
        suggestion: {
          id: suggestion.id,
          patternId: suggestion.patternId,
          patternType: suggestion.patternType,
          message: suggestion.message,
          confidenceLevel: suggestion.confidenceLevel,
          taskTitles: suggestion.taskTitles
        }
      });
    } catch (err) {
      console.error('[auto-routines] GET /suggestion error:', err.message);
      res.json({ success: true, suggestion: null }); // fail open — Buddy works without this
    }
  });

  // ─── POST /api/auto-routines/suggestion/:id/accept ───────────────────────
  // Accept a routine suggestion: create a routine from the detected pattern.
  // Body: { neverAskAgain?: boolean } (ignored for accept — always deactivate)
  router.post('/suggestion/:id/accept', async (req, res) => {
    try {
      const userId = req.user.id;
      const suggestionId = parseInt(req.params.id, 10);

      if (!suggestionId || isNaN(suggestionId)) {
        return res.status(400).json({ success: false, message: 'Invalid suggestion ID' });
      }

      const result = await acceptSuggestion(pool, userId, suggestionId);

      if (!result.success) {
        return res.status(400).json({ success: false, message: result.message });
      }

      res.json({
        success: true,
        message: result.message,
        routineId: result.routineId
      });
    } catch (err) {
      console.error('[auto-routines] POST /accept error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to accept suggestion' });
    }
  });

  // ─── POST /api/auto-routines/suggestion/:id/dismiss ──────────────────────
  // Dismiss a routine suggestion.
  // Body: { neverAskAgain?: boolean } — if true, also deactivates the underlying pattern
  router.post('/suggestion/:id/dismiss', async (req, res) => {
    try {
      const userId = req.user.id;
      const suggestionId = parseInt(req.params.id, 10);
      const { neverAskAgain } = req.body;

      if (!suggestionId || isNaN(suggestionId)) {
        return res.status(400).json({ success: false, message: 'Invalid suggestion ID' });
      }

      const result = await dismissSuggestion(pool, userId, suggestionId, neverAskAgain === true);

      if (!result.success) {
        return res.status(400).json({ success: false, message: result.message });
      }

      res.json({
        success: true,
        dismissed: true,
        deactivated: neverAskAgain === true
      });
    } catch (err) {
      console.error('[auto-routines] POST /dismiss error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to dismiss suggestion' });
    }
  });

  return router;
};