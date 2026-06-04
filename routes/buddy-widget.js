/**
 * routes/buddy-widget.js — Buddy bubble preferences + recent conversation for widget panel.
 * Mounted at /api/buddy-widget.
 *
 * Endpoints:
 *   GET  /api/buddy-widget            — load bubble visibility + position
 *   PUT  /api/buddy-widget            — update visibility + position
 *   PATCH /api/buddy-widget/position  — update position only (drag)
 *   GET  /api/buddy-widget/recent     — last N conversation turns for widget panel
 *   GET  /api/buddy-widget/has-new    — check if new Buddy message since last visit
 *   GET  /api/buddy-widget/context    — context detection data for proactive prompts
 *   GET  /api/buddy-widget/notification-count — count badge data (unclassified, checkin)
 */
const express = require('express');
const router = express.Router();

module.exports = function (pool) {

  // GET /api/buddy-widget — load current bubble preferences
  router.get('/', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
      const result = await pool.query(
        'SELECT buddy_bubble_visible, buddy_bubble_position FROM users WHERE id = $1',
        [userId]
      );
      if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found' });
      const row = result.rows[0];
      res.json({
        success: true,
        visible: row.buddy_bubble_visible,
        position: row.buddy_bubble_position || { x: 20, y: -80 }
      });
    } catch (err) {
      console.error('[buddy-widget] GET error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // PUT /api/buddy-widget — update bubble preferences
  router.put('/', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { visible, position } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ success: false, message: 'visible (boolean) is required' });
    }

    try {
      await pool.query(
        'UPDATE users SET buddy_bubble_visible = $1, buddy_bubble_position = $2 WHERE id = $3',
        [visible, JSON.stringify(position || { x: 20, y: -80 }), userId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[buddy-widget] PUT error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // PATCH /api/buddy-widget/position — update position only (called on drag)
  router.patch('/position', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { x, y } = req.body || {};
    if (typeof x !== 'number' || typeof y !== 'number') {
      return res.status(400).json({ success: false, message: 'x and y (numbers) are required' });
    }

    try {
      await pool.query(
        'UPDATE users SET buddy_bubble_position = $1 WHERE id = $2',
        [JSON.stringify({ x, y }), userId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[buddy-widget] PATCH position error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /api/buddy-widget/recent — last N conversation turns (for widget panel)
  router.get('/recent', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const limit = Math.min(parseInt(req.query.limit) || 6, 20);

    try {
      const result = await pool.query(
        `SELECT role, content, created_at
         FROM buddy_conversations
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      res.json({
        success: true,
        messages: result.rows.reverse() // oldest first for display
      });
    } catch (err) {
      console.error('[buddy-widget] GET /recent error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /api/buddy-widget/has-new — check for new Buddy messages since last visit
  router.get('/has-new', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
      const result = await pool.query(
        `SELECT COUNT(*) as cnt FROM buddy_conversations
         WHERE user_id = $1 AND role = 'buddy' AND created_at > NOW() - INTERVAL '5 minutes'`,
        [userId]
      );
      res.json({ success: true, hasNew: parseInt(result.rows[0].cnt) > 0 });
    } catch (err) {
      console.error('[buddy-widget] GET /has-new error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /api/buddy-widget/context — all data needed for context detection + proactive prompts
  router.get('/context', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const now = new Date();
    const localHour = parseInt(req.query.localHour || now.getHours());
    const isEveningTime = localHour >= 17 && localHour <= 22;

    try {
      const [taskResult, untriagedResult, checkinsResult, routineResult, buddyResult] =
        await Promise.all([
          // Incomplete task count (not done, not archived)
          pool.query(
            `SELECT COUNT(*) as cnt FROM tasks
             WHERE user_id = $1 AND completed = false AND archived = false
               AND (due_date IS NULL OR due_date >= CURRENT_DATE - INTERVAL '7 days')`,
            [userId]
          ),
          // Unclassified (Plaid-imported, is_impulse is null)
          pool.query(
            `SELECT COUNT(*) as cnt FROM expenses
             WHERE user_id = $1 AND source = 'plaid' AND is_impulse IS NULL
               AND expense_date >= CURRENT_DATE - INTERVAL '7 days'`,
            [userId]
          ),
          // Evening check-in done today?
          pool.query(
            `SELECT 1 FROM buddy_checkins
             WHERE user_id = $1 AND checkin_type = 'evening'
               AND checkin_date = CURRENT_DATE LIMIT 1`,
            [userId]
          ),
          // Missed morning routine today (routine exists, streak broken today)
          pool.query(
            `SELECT r.id, r.name FROM routines r
             LEFT JOIN routine_streaks rs ON rs.routine_id = r.id AND rs.user_id = $1
             WHERE r.user_id = $1 AND r.is_active = true
               AND r.nudge_after_hour > 0 AND r.nudge_after_hour <= $2
               AND (rs.current_streak = 0 OR rs.current_streak IS NULL)
               AND r.created_at < CURRENT_DATE
             LIMIT 1`,
            [userId, localHour]
          ),
          // New Buddy message in last 5 minutes
          pool.query(
            `SELECT COUNT(*) as cnt FROM buddy_conversations
             WHERE user_id = $1 AND role = 'buddy'
               AND created_at > NOW() - INTERVAL '5 minutes'`,
            [userId]
          ),
        ]);

      const eveningDone = checkinsResult.rows.length > 0;
      const routineMissed = routineResult.rows.length > 0;
      const hasNewBuddyMessage = parseInt(buddyResult.rows[0].cnt) > 0;

      res.json({
        success: true,
        incompleteTaskCount: parseInt(taskResult.rows[0].cnt),
        unclassifiedCount: parseInt(untriagedResult.rows[0].cnt),
        isEveningTime,
        eveningCheckinDone: eveningDone,
        routineMissed,
        hasNewBuddyMessage,
        firstMoneyVisit: false, // determined client-side via localStorage
        taskJustCompleted: false, // pushed from task completion events
        sessionComplete: eveningDone,
        routineName: routineMissed ? routineResult.rows[0]?.name : null,
      });
    } catch (err) {
      console.error('[buddy-widget] GET /context error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  // GET /api/buddy-widget/notification-count — notification dot badge data
  router.get('/notification-count', async (req, res) => {
    const auth = req.headers['authorization'];
    if (!auth) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let userId;
    try {
      const { verifyToken } = require('../middleware/auth');
      const decoded = verifyToken(auth.split(' ')[1]);
      userId = decoded?.id;
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
      const [untriagedResult, buddyResult, checkinResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) as cnt FROM expenses
           WHERE user_id = $1 AND source = 'plaid' AND is_impulse IS NULL
             AND expense_date >= CURRENT_DATE - INTERVAL '7 days'`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) as cnt FROM buddy_conversations
           WHERE user_id = $1 AND role = 'buddy'
             AND created_at > NOW() - INTERVAL '5 minutes'`,
          [userId]
        ),
        pool.query(
          `SELECT 1 FROM buddy_checkins
           WHERE user_id = $1 AND checkin_type = 'evening'
             AND checkin_date = CURRENT_DATE LIMIT 1`,
          [userId]
        ),
      ]);

      const unclassified = parseInt(untriagedResult.rows[0].cnt);
      const buddyNew = parseInt(buddyResult.rows[0].cnt) > 0;
      const eveningDone = checkinResult.rows.length > 0;

      // Badge count: unclassified transactions (primary) + buddy message indicator
      const count = unclassified;
      const hasBuddyMessage = buddyNew;

      res.json({
        success: true,
        count,
        hasBuddyMessage,
        eveningReady: !eveningDone,
      });
    } catch (err) {
      console.error('[buddy-widget] GET /notification-count error:', err.message);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  return router;
};