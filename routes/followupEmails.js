'use strict';
/**
 * Follow-up Email API — preference management and history.
 * Manages: followup_email_types, user_followup_prefs, followup_email_log tables.
 *
 * GET  /api/followup-emails/types   → list email types
 * GET  /api/followup-emails/prefs   → current user prefs
 * PUT  /api/followup-emails/prefs   → update user prefs
 * GET  /api/followup-emails/log     → recent sent history (30 days)
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const {
  getEmailTypes,
  getUserPrefs,
  upsertUserPrefs,
  getRecentLogs,
} = require('../db/followupEmails');

module.exports = function(pool) {
  const router = express.Router();

  router.get('/types', authenticateToken, async (req, res) => {
    try {
      const types = await getEmailTypes(pool);
      res.json({ success: true, types });
    } catch (err) {
      console.error('[followupEmails/types GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  router.get('/prefs', authenticateToken, async (req, res) => {
    try {
      const userPrefs = await getUserPrefs(pool, req.user.id);
      if (!userPrefs) {
        return res.json({
          success: true,
          prefs: {
            task_reminder:    true,  task_reminder_hour:    8,
            routine_streak:   true,  routine_streak_hour:   9,
            weekly_summary:   true,  weekly_summary_hour:   8,
            follow_through:   true,  follow_through_hour:  10,
            source: 'defaults',
          }
        });
      }
      res.json({ success: true, prefs: { ...userPrefs, source: 'stored' } });
    } catch (err) {
      console.error('[followupEmails/prefs GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  router.put('/prefs', authenticateToken, async (req, res) => {
    try {
      const {
        task_reminder, task_reminder_hour,
        routine_streak, routine_streak_hour,
        weekly_summary, weekly_summary_hour,
        follow_through, follow_through_hour,
      } = req.body;

      if (
        typeof task_reminder !== 'boolean' || typeof routine_streak !== 'boolean' ||
        typeof weekly_summary !== 'boolean' || typeof follow_through !== 'boolean' ||
        typeof task_reminder_hour !== 'number' || typeof routine_streak_hour !== 'number' ||
        typeof weekly_summary_hour !== 'number' || typeof follow_through_hour !== 'number'
      ) {
        return res.status(400).json({ success: false, message: 'All preference fields are required' });
      }

      const hours = [task_reminder_hour, routine_streak_hour, weekly_summary_hour, follow_through_hour];
      if (hours.some(h => h < 0 || h > 23 || !Number.isInteger(h))) {
        return res.status(400).json({ success: false, message: 'Hours must be integers 0-23' });
      }

      await upsertUserPrefs(pool, req.user.id, {
        task_reminder, task_reminder_hour,
        routine_streak, routine_streak_hour,
        weekly_summary, weekly_summary_hour,
        follow_through, follow_through_hour,
      });
      res.json({ success: true, message: 'Preferences updated' });
    } catch (err) {
      console.error('[followupEmails/prefs PUT]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  router.get('/log', authenticateToken, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const logs = await getRecentLogs(pool, req.user.id, limit);
      res.json({ success: true, logs });
    } catch (err) {
      console.error('[followupEmails/log GET]', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  return router;
};