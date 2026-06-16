// Owns: Routine Nudge System API — CRUD for routines and task links,
//       nudge event status updates, streak reads, nudge preference settings,
//       routine template library (read-only), and create-from-template flow.
// Does NOT own: task CRUD, Buddy conversation, push notifications,
//               or scheduled nudge check logic (see lib/routineNudgeEngine.js).
//
// Endpoints:
//   GET  /api/routines               — list user's routines + tasks + streaks
//   POST /api/routines               — create a new routine
//   GET  /api/routines/templates     — list all pre-built routine templates
//   POST /api/routines/from-template — create a routine + tasks from a template
//   PUT  /api/routines/:id           — update a routine
//   DELETE /api/routines/:id         — deactivate a routine
//   POST /api/routines/:id/tasks     — add a task to a routine
//   DELETE /api/routines/:id/tasks/:taskId — remove a task from a routine
//   POST /api/routines/:id/complete  — record routine completion for today
//   GET  /api/routines/streaks       — get all streak data (private, profile view)
//   GET  /api/routines/nudges        — get pending nudges for today's session
//   POST /api/routines/nudges/:eventId/status — update nudge status (on_it/skipped/etc)
//   GET  /api/routines/nudge-prefs   — get nudge delivery preferences
//   PUT  /api/routines/nudge-prefs   — update nudge delivery preferences

'use strict';

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { sendPushToUser } = require('../lib/sendPushToUser');
const {
  createRoutine,
  getUserRoutines,
  updateRoutine,
  deleteRoutine,
  getRoutineForUser,
  getTaskForUser,
  addTaskToRoutine,
  removeTaskFromRoutine,
  recordRoutineCompletion,
  getUserStreaks,
  updateNudgeStatus,
  getNudgePrefs,
  setNudgePrefs,
} = require('../db/routineNudges');
const {
  getTemplates,
  getTemplateById,
  stampSourceTemplate,
  createTaskStub,
} = require('../db/routineTemplates');
const {
  checkAndGenerateNudges,
  getSessionNudges,
  getLocalTimeString,
} = require('../lib/routineNudgeEngine');

const VALID_TYPES = ['am', 'pm', 'weekly'];
const VALID_STATUSES = ['on_it', 'skipped', 'snoozed'];
const VALID_FREQS = ['gentle', 'normal', 'off'];

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── Static paths first — must come before parameterized /:id routes ───────
  // WHY: Express matches in registration order. PUT /nudge-prefs would be
  // swallowed by PUT /:id if parameterized routes were registered first.

  // ─── GET /api/routines ─────────────────────────────────────────────────────
  // List all active routines for the user, each with their linked tasks.
  router.get('/', async (req, res) => {
    try {
      const routines = await getUserRoutines(pool, req.user.id);
      res.json({ success: true, routines });
    } catch (err) {
      console.error('[routines] GET / error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load routines' });
    }
  });

  // ─── POST /api/routines ────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const { name, routine_type, nudge_after_hour, day_of_week } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'name is required' });
      }
      if (routine_type && !VALID_TYPES.includes(routine_type)) {
        return res.status(400).json({ success: false, message: `routine_type must be one of: ${VALID_TYPES.join(', ')}` });
      }
      const routine = await createRoutine(pool, req.user.id, {
        name, routine_type, nudge_after_hour, day_of_week
      });
      res.json({ success: true, routine });
    } catch (err) {
      console.error('[routines] POST / error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to create routine' });
    }
  });

  // ─── GET /api/routines/templates ──────────────────────────────────────────
  // Return all pre-built routine templates (global, read-only, no auth needed
  // beyond the authenticateToken middleware already applied to this router).
  router.get('/templates', async (req, res) => {
    try {
      const templates = await getTemplates(pool);
      res.json({ success: true, templates });
    } catch (err) {
      console.error('[routines] GET /templates error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load templates' });
    }
  });

  // ─── POST /api/routines/from-template ─────────────────────────────────────
  // Create a user routine (and its task stubs) from a template.
  // Body: { template_id, name? (override), routine_type?, nudge_after_hour? }
  // Each template task becomes a real task owned by the user and linked to
  // the new routine. The routine carries source_template_id for UI labelling.
  router.post('/from-template', async (req, res) => {
    try {
      const userId = req.user.id;
      const { template_id, name: nameOverride, routine_type, nudge_after_hour } = req.body;

      if (!template_id) {
        return res.status(400).json({ success: false, message: 'template_id is required' });
      }

      const template = await getTemplateById(pool, parseInt(template_id, 10));
      if (!template) {
        return res.status(404).json({ success: false, message: 'Template not found' });
      }

      // Map template category → routine_type default
      const categoryTypeMap = { morning: 'am', evening: 'pm', weekly: 'weekly', productivity: 'am', movement: 'am' };
      const resolvedType = routine_type || categoryTypeMap[template.category] || 'am';
      const resolvedName = (nameOverride || '').trim() || template.name;

      // Create the routine
      const routine = await createRoutine(pool, userId, {
        name: resolvedName,
        routine_type: resolvedType,
        nudge_after_hour,
        // Store template origin on the routine for "Adopted from X" label
        // We patch source_template_id directly since createRoutine doesn't have it.
      });

      // Stamp source_template_id so the UI can show "Adopted from [Template Name]"
      await stampSourceTemplate(pool, routine.id, template.id);
      routine.source_template_id = template.id;
      routine.source_template_name = template.name;

      // Create a task stub for each template task and link it to the routine
      const tasks = Array.isArray(template.tasks) ? template.tasks : [];
      const createdTasks = [];
      for (const t of tasks.sort((a, b) => (a.order || 0) - (b.order || 0))) {
        const task = await createTaskStub(pool, userId, t.title);
        await addTaskToRoutine(pool, routine.id, task.id);
        createdTasks.push(task);
      }

      res.json({ success: true, routine: { ...routine, tasks: createdTasks }, template });
    } catch (err) {
      console.error('[routines] POST /from-template error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to create routine from template' });
    }
  });

  // ─── GET /api/routines/streaks ─────────────────────────────────────────────
  // Private streak data for profile view. Never gamified, never shared.
  router.get('/streaks', async (req, res) => {
    try {
      const streaks = await getUserStreaks(pool, req.user.id);
      res.json({ success: true, streaks });
    } catch (err) {
      console.error('[routines] GET /streaks error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load streaks' });
    }
  });

  // ─── GET /api/routines/nudges ──────────────────────────────────────────────
  // Get active nudges for today's session. Also triggers nudge generation if
  // we're past the trigger hour for any routine. Called at session start.
  router.get('/nudges', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = getUserLocalDate(tz);
      const localTime = getLocalTimeString(tz);

      // Generate any new nudge events first (idempotent)
      await checkAndGenerateNudges(pool, userId, localDate, tz);

      // Fetch enriched pending nudges with Buddy copy
      const nudges = await getSessionNudges(pool, userId, localDate, localTime);

      res.json({ success: true, nudges, date: localDate });
    } catch (err) {
      console.error('[routines] GET /nudges error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load nudges' });
    }
  });

  // ─── POST /api/routines/nudges/:eventId/status ─────────────────────────────
  // Update nudge status: on_it | skipped | snoozed | reschedule | deprioritize
  router.post('/nudges/:eventId/status', async (req, res) => {
    try {
      const nudgeEventId = parseInt(req.params.eventId, 10);
      const { status } = req.body;

      if (!VALID_STATUSES.concat(['reschedule', 'deprioritize']).includes(status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${VALID_STATUSES.join(', ')}, reschedule, deprioritize` });
      }

      // Map escalation actions to DB-valid statuses
      const dbStatus = status === 'reschedule' ? 'skipped'
        : status === 'deprioritize' ? 'skipped'
        : status;

      const updated = await updateNudgeStatus(pool, req.user.id, nudgeEventId, dbStatus);
      if (!updated) return res.status(404).json({ success: false, message: 'Nudge event not found' });

      res.json({ success: true, nudge: updated, action: status });
    } catch (err) {
      console.error('[routines] POST /nudges/:eventId/status error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update nudge status' });
    }
  });

  // ─── GET /api/routines/nudge-prefs ────────────────────────────────────────
  router.get('/nudge-prefs', async (req, res) => {
    try {
      const prefs = await getNudgePrefs(pool, req.user.id);
      res.json({ success: true, prefs });
    } catch (err) {
      console.error('[routines] GET /nudge-prefs error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load preferences' });
    }
  });

  // ─── PUT /api/routines/nudge-prefs ────────────────────────────────────────
  router.put('/nudge-prefs', async (req, res) => {
    try {
      const { nudges_enabled, frequency } = req.body;

      if (frequency != null && !VALID_FREQS.includes(frequency)) {
        return res.status(400).json({ success: false, message: `frequency must be one of: ${VALID_FREQS.join(', ')}` });
      }

      const prefs = await setNudgePrefs(pool, req.user.id, { nudges_enabled, frequency });
      res.json({ success: true, prefs });
    } catch (err) {
      console.error('[routines] PUT /nudge-prefs error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update preferences' });
    }
  });

  // ─── Parameterized /:id routes — must come after static paths ─────────────

  // ─── PUT /api/routines/:id ─────────────────────────────────────────────────
  router.put('/:id', async (req, res) => {
    try {
      const routineId = parseInt(req.params.id, 10);
      const { name, routine_type, nudge_after_hour, day_of_week, is_active } = req.body;
      if (routine_type && !VALID_TYPES.includes(routine_type)) {
        return res.status(400).json({ success: false, message: `routine_type must be one of: ${VALID_TYPES.join(', ')}` });
      }
      const updated = await updateRoutine(pool, req.user.id, routineId, {
        name, routine_type, nudge_after_hour, day_of_week, is_active
      });
      if (!updated) return res.status(404).json({ success: false, message: 'Routine not found' });
      res.json({ success: true, routine: updated });
    } catch (err) {
      console.error('[routines] PUT /:id error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to update routine' });
    }
  });

  // ─── DELETE /api/routines/:id ──────────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    try {
      await deleteRoutine(pool, req.user.id, parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (err) {
      console.error('[routines] DELETE /:id error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to delete routine' });
    }
  });

  // ─── POST /api/routines/:id/tasks ─────────────────────────────────────────
  // Add a task to this routine. Validates task belongs to user.
  router.post('/:id/tasks', async (req, res) => {
    try {
      const routineId = parseInt(req.params.id, 10);
      const { task_id } = req.body;
      if (!task_id) return res.status(400).json({ success: false, message: 'task_id is required' });

      // Verify routine belongs to user
      const routine = await getRoutineForUser(pool, req.user.id, routineId, true);
      if (!routine) return res.status(404).json({ success: false, message: 'Routine not found' });

      // Verify task belongs to user
      const task = await getTaskForUser(pool, req.user.id, task_id);
      if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

      await addTaskToRoutine(pool, routineId, task_id);
      res.json({ success: true });
    } catch (err) {
      console.error('[routines] POST /:id/tasks error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to add task' });
    }
  });

  // ─── DELETE /api/routines/:id/tasks/:taskId ────────────────────────────────
  router.delete('/:id/tasks/:taskId', async (req, res) => {
    try {
      const routineId = parseInt(req.params.id, 10);
      const taskId = parseInt(req.params.taskId, 10);

      // Verify routine belongs to user
      const routine = await getRoutineForUser(pool, req.user.id, routineId);
      if (!routine) return res.status(404).json({ success: false, message: 'Routine not found' });

      await removeTaskFromRoutine(pool, routineId, taskId);
      res.json({ success: true });
    } catch (err) {
      console.error('[routines] DELETE /:id/tasks/:taskId error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to remove task' });
    }
  });

  // ─── POST /api/routines/:id/complete ──────────────────────────────────────
  // Record that a routine was completed today (updates streak).
  router.post('/:id/complete', async (req, res) => {
    try {
      const routineId = parseInt(req.params.id, 10);
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const localDate = req.body.date || getUserLocalDate(tz);

      // Verify routine belongs to user
      const routine = await getRoutineForUser(pool, userId, routineId);
      if (!routine) return res.status(404).json({ success: false, message: 'Routine not found' });

      const streak = await recordRoutineCompletion(pool, userId, routineId, localDate);
      res.json({ success: true, streak });

      // Fire-and-forget push for tasks anchored to this routine
      setImmediate(async () => {
        try {
          const { rows: anchored } = await pool.query(
            `SELECT id, title, anchor_label FROM tasks
             WHERE anchor_routine_id = $1 AND user_id = $2 AND is_completed = false`,
            [routineId, userId]
          );
          for (const task of anchored) {
            const cue = task.anchor_label || `Time for: ${task.title}`;
            await sendPushToUser(pool, userId, {
              title: 'Habit stack 🔗',
              body: cue,
              url: '/app/tasks',
            });
          }
        } catch { /* non-blocking */ }
      });
    } catch (err) {
      console.error('[routines] POST /:id/complete error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to record completion' });
    }
  });

  return router;
};
