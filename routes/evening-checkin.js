// Owns: Evening wrap-up endpoints — pre-computed stats for the full wrap-up page,
//       storing the complete P2 evening recap (energy, blocks, tasks, routines,
//       documents, money tasks). Extends the existing /api/buddy/evening POST.
//
// Does NOT own: morning check-in, daily plan generation, coaching conversation,
//               pattern detection, mid-day check-ins, or brain-dump parsing.

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── GET /api/buddy/evening-data ───────────────────────────────────────
  // P2: Pre-computed stats for the full evening wrap-up page.
  // Returns tasks completed, routines kept, docs handled, money tasks done.
  router.get('/evening-data', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      const [tasksResult, routinesResult, explicitRoutinesResult, docsResult, moneyTasksResult, openResult] = await Promise.all([
        pool.query(`
          SELECT COUNT(*) as count FROM tasks
          WHERE user_id = $1 AND is_completed = true AND completed_at::date = $2::date
        `, [userId, today]),
        pool.query(`
          SELECT COUNT(DISTINCT r.id) as count
          FROM routines r
          JOIN routine_nudge_events rne ON rne.routine_id = r.id AND rne.nudge_date = $2
          JOIN routine_task_links rtl ON rtl.routine_id = r.id
          JOIN tasks t ON t.id = rtl.task_id AND t.is_completed = true AND t.completed_at::date = $2::date
          WHERE r.user_id = $1 AND r.is_active = true
        `, [userId, today]),
        pool.query(`
          SELECT COUNT(*) as count FROM routine_streaks
          WHERE user_id = $1 AND last_completed_date = $2
        `, [userId, today]),
        pool.query(`
          SELECT COUNT(*) as count FROM documents
          WHERE user_id = $1 AND updated_at::date = $2::date
        `, [userId, today]),
        pool.query(`
          SELECT COUNT(*) as count FROM tasks
          WHERE user_id = $1
            AND is_completed = true
            AND completed_at::date = $2::date
            AND (
              categorytag ILIKE '%money%' OR
              categorytag ILIKE '%budget%' OR
              categorytag ILIKE '%spending%' OR
              categorytag ILIKE '%expense%' OR
              categorytag ILIKE '%bill%' OR
              title ILIKE '%budget%' OR
              title ILIKE '%bill%' OR
              title ILIKE '%money%' OR
              title ILIKE '%expense%'
            )
        `, [userId, today]),
        pool.query(`
          SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false
        `, [userId])
      ]);

      const routinesKept = Math.max(
        parseInt(routinesResult.rows[0].count, 10),
        parseInt(explicitRoutinesResult.rows[0].count, 10)
      );

      res.json({
        success: true,
        tasksCompletedToday: parseInt(tasksResult.rows[0].count, 10),
        tasksOpen: parseInt(openResult.rows[0].count, 10),
        routinesKeptToday: routinesKept,
        documentsHandled: parseInt(docsResult.rows[0].count, 10),
        moneyTasksDone: parseInt(moneyTasksResult.rows[0].count, 10)
      });
    } catch (err) {
      console.error('[evening] GET /evening-data error:', err.message);
      res.json({ success: true, tasksCompletedToday: 0, tasksOpen: 0, routinesKeptToday: 0, documentsHandled: 0, moneyTasksDone: 0 });
    }
  });

  // ─── POST /api/buddy/evening ─────────────────────────────────────────────
  // P2: Store full evening wrap-up — extends beyond just money tasks.
  // Body: { date?, energy_level?, blocks_text?,
  //         tasks_completed_today?, routines_kept_today?,
  //         documents_handled?, money_tasks_done? }
  router.post('/evening', async (req, res) => {
    try {
      const userId = req.user.id;
      const { date, energy_level, blocks_text,
              tasks_completed_today, routines_kept_today,
              documents_handled, money_tasks_done } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      const completedResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks
        WHERE user_id = $1 AND is_completed = true AND completed_at::date = $2::date
      `, [userId, today]);

      const openResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false
      `, [userId]);

      const tasksCompleted = parseInt(completedResult.rows[0].count, 10);
      const tasksOpen = parseInt(openResult.rows[0].count, 10);

      const planResult = await pool.query(
        'SELECT task_1_id, task_2_id, task_3_id FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2',
        [userId, today]
      );

      if (planResult.rows.length > 0) {
        const plan = planResult.rows[0];
        const planTaskIds = [plan.task_1_id, plan.task_2_id, plan.task_3_id].filter(Boolean);
        if (planTaskIds.length > 0) {
          const compCheck = await pool.query(
            `SELECT id FROM tasks WHERE id = ANY($1) AND is_completed = true`,
            [planTaskIds]
          );
          await pool.query(
            `UPDATE buddy_daily_plans SET tasks_completed = $1 WHERE user_id = $2 AND plan_date = $3`,
            [compCheck.rows.length, userId, today]
          );
        }
      }

      const result = await pool.query(`
        INSERT INTO buddy_checkins
          (user_id, checkin_date, checkin_type,
           tasks_completed, tasks_open,
           energy_level, blocks_text,
           tasks_completed_today, routines_kept_today,
           documents_handled, money_tasks_done)
        VALUES ($1, $2, 'evening', $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (user_id, checkin_date, checkin_type)
        DO UPDATE SET
          tasks_completed = EXCLUDED.tasks_completed,
          tasks_open = EXCLUDED.tasks_open,
          energy_level = COALESCE(EXCLUDED.energy_level, buddy_checkins.energy_level),
          blocks_text = COALESCE(EXCLUDED.blocks_text, buddy_checkins.blocks_text),
          tasks_completed_today = COALESCE(EXCLUDED.tasks_completed_today, buddy_checkins.tasks_completed_today),
          routines_kept_today = COALESCE(EXCLUDED.routines_kept_today, buddy_checkins.routines_kept_today),
          documents_handled = COALESCE(EXCLUDED.documents_handled, buddy_checkins.documents_handled),
          money_tasks_done = COALESCE(EXCLUDED.money_tasks_done, buddy_checkins.money_tasks_done)
        RETURNING *
      `, [
        userId, today,
        tasksCompleted, tasksOpen,
        energy_level || null,
        blocks_text || null,
        tasks_completed_today != null ? tasks_completed_today : null,
        routines_kept_today != null ? routines_kept_today : null,
        documents_handled != null ? documents_handled : null,
        money_tasks_done != null ? money_tasks_done : null
      ]);

      res.json({ success: true, checkin: result.rows[0], tasksCompleted, tasksOpen });
    } catch (err) {
      console.error('[evening] POST /evening error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save evening recap' });
    }
  });

  return router;
};