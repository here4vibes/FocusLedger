'use strict';
/**
 * POST /api/push-actions/done — the "Done ✓" button on a task notification.
 *
 * Called by the service worker, which has no app auth; the signed token in the
 * body is the authorization (one task, one user, 72h; lib/push-action-token.js).
 */
const express = require('express');
const { verifyTaskDoneToken } = require('../lib/push-action-token');
const { markTaskDone } = require('../db/task-completion');
const { onTasksCompleted } = require('../lib/routine-capture');
const { logFailure } = require('../lib/log-failure');

module.exports = function (pool) {
  const router = express.Router();

  router.post('/done', async (req, res) => {
    const claims = verifyTaskDoneToken(req.body && req.body.token);
    if (!claims) return res.status(401).json({ success: false, message: 'This button has expired. Open the app to finish it.' });
    try {
      const result = await markTaskDone(pool, claims.userId, claims.taskId);
      if (!result.found) return res.status(404).json({ success: false, message: 'That task is gone.' });
      const routineCompleted = result.changed
        ? await onTasksCompleted(pool, claims.userId, claims.taskId)
            .catch(logFailure('[push-actions]', 'onTasksCompleted', { userId: claims.userId, taskId: claims.taskId }, []))
        : [];
      console.log('[push-actions] task done from notification | userId:', claims.userId, '| taskId:', claims.taskId, '| changed:', result.changed);
      res.json({ success: true, title: result.title, already_done: !result.changed, routine_completed: routineCompleted });
    } catch (e) {
      console.error('[push-actions] done failed:', e.message, '| userId:', claims.userId, '| taskId:', claims.taskId);
      res.status(500).json({ success: false, message: 'That didn’t save. Open the app to finish it.' });
    }
  });

  return router;
};
