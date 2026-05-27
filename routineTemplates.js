// Owns: routine_templates table — read-only pre-built routine library.
//       Also owns helper for stamping source_template_id on user routines
//       and creating per-user task stubs from a template.
// Does NOT own: routines table business logic, task lifecycle, or auth.

'use strict';

/**
 * Return all available routine templates, ordered by category then id.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array>}
 */
async function getTemplates(pool) {
  const result = await pool.query(
    `SELECT id, name, category, description, estimated_minutes, tasks
     FROM routine_templates
     ORDER BY CASE category
       WHEN 'morning'      THEN 1
       WHEN 'evening'      THEN 2
       WHEN 'weekly'       THEN 3
       WHEN 'productivity' THEN 4
       WHEN 'movement'     THEN 5
       ELSE 6
     END, id ASC`
  );
  return result.rows;
}

/**
 * Return a single template by id, or null if not found.
 * @param {import('pg').Pool} pool
 * @param {number} templateId
 * @returns {Promise<Object|null>}
 */
async function getTemplateById(pool, templateId) {
  const result = await pool.query(
    `SELECT id, name, category, description, estimated_minutes, tasks
     FROM routine_templates
     WHERE id = $1`,
    [templateId]
  );
  return result.rows[0] || null;
}

/**
 * Stamp source_template_id on a routine that was adopted from a template.
 * Returns the updated routine row.
 */
async function stampSourceTemplate(pool, routineId, templateId) {
  const result = await pool.query(
    `UPDATE routines SET source_template_id = $1 WHERE id = $2 RETURNING *`,
    [templateId, routineId]
  );
  return result.rows[0] || null;
}

/**
 * Create a task stub owned by userId with the given title.
 * Returns { id, title }.
 */
async function createTaskStub(pool, userId, title) {
  const result = await pool.query(
    `INSERT INTO tasks (user_id, title, is_completed) VALUES ($1, $2, false) RETURNING id, title`,
    [userId, title]
  );
  return result.rows[0];
}

/**
 * Update a task's title.
 */
async function updateTaskTitle(pool, userId, taskId, title) {
  await pool.query(
    `UPDATE tasks SET title = $1 WHERE id = $2 AND user_id = $3`,
    [title, taskId, userId]
  );
}

module.exports = { getTemplates, getTemplateById, stampSourceTemplate, createTaskStub, updateTaskTitle };
