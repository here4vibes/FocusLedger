'use strict';
/**
 * Activation funnel: how far does each new account get?
 *
 * Built from data the app already stores (no client tracking to block or
 * lose): every non-QA account, and whether it ever created a task, finished
 * one, talked to Buddy, and came back on a later day than it signed up.
 * Stages are cumulative milestones, not a strict sequence.
 */

const STAGES = [
  { key: 'signed_up', label: 'Signed up' },
  { key: 'created_task', label: 'Created a task' },
  { key: 'completed_task', label: 'Finished a task' },
  { key: 'used_buddy', label: 'Talked to Buddy' },
  { key: 'came_back', label: 'Came back another day' },
];

// Signup seeds a starter routine (lib/seedStarterRoutine.js) whose tasks carry no
// marker; they're the tasks linked to a template-sourced routine. Those don't
// count as the person creating or finishing a task of their own.
const OWN_TASK = `NOT EXISTS (
      SELECT 1 FROM routine_task_links l JOIN routines r ON r.id = l.routine_id
      WHERE l.task_id = t.id AND r.source_template_id IS NOT NULL)`;

const PER_USER_SQL = `
  SELECT
    u.id,
    u.email,
    u.created_at,
    u.last_active_at,
    EXISTS (SELECT 1 FROM tasks t WHERE t.user_id = u.id AND ${OWN_TASK}) AS created_task,
    EXISTS (SELECT 1 FROM tasks t WHERE t.user_id = u.id AND t.is_completed AND ${OWN_TASK}) AS completed_task,
    (EXISTS (SELECT 1 FROM buddy_conversations c WHERE c.user_id = u.id AND c.role = 'user')
     OR EXISTS (SELECT 1 FROM buddy_checkins b WHERE b.user_id = u.id)) AS used_buddy,
    (u.created_at IS NOT NULL AND u.last_active_at IS NOT NULL
     AND u.last_active_at::date > u.created_at::date) AS came_back
  FROM users u
  WHERE COALESCE(u.is_qa_user, false) = false
    AND ($1::int IS NULL OR u.created_at >= NOW() - make_interval(days => $1::int))
  ORDER BY u.created_at DESC NULLS LAST, u.id DESC`;

/**
 * @param {import('pg').Pool} pool
 * @param {{ days?: number|null }} [opts] restrict to accounts created in the last N days
 * @returns {Promise<{ stages: Array<{key,label,count,pct}>, users: Array<object> }>}
 */
async function getActivationFunnel(pool, { days = null } = {}) {
  const { rows } = await pool.query(PER_USER_SQL, [days]);
  const total = rows.length;
  const stages = STAGES.map(s => {
    const count = s.key === 'signed_up' ? total : rows.filter(r => r[s.key]).length;
    return { ...s, count, pct: total ? Math.round((count / total) * 100) : 0 };
  });
  const users = rows.map(r => {
    // Furthest milestone reached, in funnel order.
    let furthest = 'signed_up';
    for (const s of STAGES) if (s.key === 'signed_up' || r[s.key]) furthest = s.key;
    return {
      id: r.id,
      email: r.email,
      created_at: r.created_at,
      last_active_at: r.last_active_at,
      created_task: r.created_task,
      completed_task: r.completed_task,
      used_buddy: r.used_buddy,
      came_back: r.came_back,
      furthest,
    };
  });
  return { stages, users };
}

module.exports = { getActivationFunnel, STAGES };
