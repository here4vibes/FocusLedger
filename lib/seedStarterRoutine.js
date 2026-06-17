'use strict';
/**
 * lib/seedStarterRoutine.js
 *
 * Called fire-and-forget after new user signup.
 * Creates a Morning Essentials routine from the template so the user
 * has something to start with without any setup required.
 * No-ops if the user already has a morning routine or if the template
 * doesn't exist yet (e.g., migration hasn't run).
 */

const { createRoutine, addTaskToRoutine } = require('../db/routineNudges');
const { getTemplateById, stampSourceTemplate, createTaskStub } = require('../db/routineTemplates');

module.exports = async function seedStarterRoutine(pool, userId) {
  // Find the template by name — avoids hardcoding an ID that could shift across envs
  const tmplResult = await pool.query(
    `SELECT id FROM routine_templates WHERE name = 'Morning Essentials' LIMIT 1`
  );
  if (!tmplResult.rows.length) return; // migration hasn't run yet

  // Don't clobber if user already has a morning routine
  const existing = await pool.query(
    `SELECT id FROM routines WHERE user_id = $1 AND routine_type = 'am' AND is_active = true LIMIT 1`,
    [userId]
  );
  if (existing.rows.length) return;

  const templateId = tmplResult.rows[0].id;
  const template = await getTemplateById(pool, templateId);
  if (!template) return;

  const routine = await createRoutine(pool, userId, {
    name: 'Morning Essentials',
    routine_type: 'am',
    nudge_after_hour: 9,
  });

  await stampSourceTemplate(pool, routine.id, templateId);

  const tasks = Array.isArray(template.tasks) ? template.tasks : [];
  for (const t of tasks.sort((a, b) => (a.order || 0) - (b.order || 0))) {
    const task = await createTaskStub(pool, userId, t.title);
    await addTaskToRoutine(pool, routine.id, task.id);
  }
};
