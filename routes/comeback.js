// Owns: comeback flow detection + dismissal tracking.
// Does NOT own: login/auth, buddy conversations, nudge scheduling.
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getComebackStatus, markComebackShown } = require('../db/comeback');

module.exports = function(pool) {
  const router = express.Router();

  // GET /api/comeback/status
  // Returns whether the user should see the comeback welcome-back flow.
  // Called on app load to check if a "welcome back" modal should appear.
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const status = await getComebackStatus(pool, req.user.id);
      res.json({ success: true, ...status });
    } catch (err) {
      console.error('[comeback/status] Error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to check comeback status' });
    }
  });

  // POST /api/comeback/dismiss
  // Called when user dismisses/acts on the comeback modal.
  // Prevents re-showing the same flow for 7 days.
  router.post('/dismiss', authenticateToken, async (req, res) => {
    try {
      await markComebackShown(pool, req.user.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[comeback/dismiss] Error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to record dismiss' });
    }
  });

  return router;
};