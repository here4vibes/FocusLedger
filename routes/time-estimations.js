/**
 * routes/time-estimations.js — Time-Blindness P1 API endpoints.
 *
 * Owns: POST /tasks/:taskId/estimate, POST /tasks/:taskId/complete-with-time,
 *       GET /time-estimates/history, GET /time-estimates/calibration,
 *       GET /time-estimates/suggest
 * Does NOT own: task CRUD, focus sessions, or duration field on tasks table.
 */

'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const TimeEstimationService = require('../services/TimeEstimationService');
const timeEstDb = require('../db/time-estimations');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // POST /api/v1/tasks/:taskId/estimate
  // Record or update a time estimate for a task.
  router.post('/tasks/:taskId/estimate', async (req, res) => {
    try {
      const userId = req.user.id;
      const taskId = parseInt(req.params.taskId, 10);
      const { estimated_minutes } = req.body;

      if (!taskId || isNaN(taskId)) {
        return res.status(400).json({ success: false, message: 'Invalid task ID' });
      }
      const mins = parseInt(estimated_minutes, 10);
      if (!mins || mins < 1 || mins > 480) {
        return res.status(400).json({ success: false, message: 'estimated_minutes must be 1-480' });
      }

      const estimation = await TimeEstimationService.recordEstimation(pool, userId, taskId, mins);
      res.json({ success: true, estimation });
    } catch (err) {
      console.error('[time-estimations] estimate error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to record estimate' });
    }
  });

  // POST /api/v1/tasks/:taskId/complete-with-time
  // Record actual time and compute calibration score.
  router.post('/tasks/:taskId/complete-with-time', async (req, res) => {
    try {
      const userId = req.user.id;
      const taskId = parseInt(req.params.taskId, 10);
      const { actual_minutes } = req.body;

      if (!taskId || isNaN(taskId)) {
        return res.status(400).json({ success: false, message: 'Invalid task ID' });
      }
      const mins = parseInt(actual_minutes, 10);
      if (!mins || mins < 1 || mins > 1440) {
        return res.status(400).json({ success: false, message: 'actual_minutes must be 1-1440' });
      }

      const result = await TimeEstimationService.recordCompletion(pool, taskId, userId, mins);
      if (!result) {
        return res.status(404).json({ success: false, message: 'No estimation found for this task' });
      }

      res.json({ success: true, result });
    } catch (err) {
      console.error('[time-estimations] complete-with-time error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to record actual time' });
    }
  });

  // GET /api/v1/time-estimates/history
  // Last 20 estimations with task titles and calibration data.
  router.get('/time-estimates/history', async (req, res) => {
    try {
      const userId = req.user.id;
      const estimates = await timeEstDb.getHistory(pool, userId, 20);
      res.json({ success: true, estimates });
    } catch (err) {
      console.error('[time-estimations] history error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
  });

  // GET /api/v1/time-estimates/calibration
  // Aggregated calibration stats.
  router.get('/time-estimates/calibration', async (req, res) => {
    try {
      const userId = req.user.id;
      const calibration = await TimeEstimationService.getCalibration(pool, userId);
      res.json({ success: true, calibration });
    } catch (err) {
      console.error('[time-estimations] calibration error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch calibration' });
    }
  });

  // GET /api/v1/time-estimates/suggest?title=Buy+groceries
  // Suggest estimate based on similar past tasks.
  router.get('/time-estimates/suggest', async (req, res) => {
    try {
      const userId = req.user.id;
      const title = req.query.title;

      if (!title || title.trim().length < 3) {
        return res.json({ success: true, suggestion: null });
      }

      const suggestion = await TimeEstimationService.suggestEstimate(pool, userId, title.trim());
      res.json({ success: true, suggestion });
    } catch (err) {
      console.error('[time-estimations] suggest error:', err.message);
      // Silent fail — suggestions are a nice-to-have
      res.json({ success: true, suggestion: null });
    }
  });

  return router;
};
