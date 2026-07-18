'use strict';
/**
 * lib/agent-tools.js — the allow-list of actions Buddy can execute, plus the
 * dispatcher and the reverser. Single source of truth for Cowork Stage 1.
 * See docs/cowork-stage1-spec.md.
 *
 * The model may PROPOSE any tool here; the TIER (not the model) decides whether
 * it runs without a human tap: 'auto' = in-app + reversible (run now, offer
 * Undo); 'confirm' = outward/irreversible (never auto-run — Stage 1.4).
 *
 * Stage 1 ships two 'auto' tools that only touch the user's own tasks and are
 * fully reversible — zero external risk, to prove the loop.
 */

// Anthropic tool schemas exposed to the model.
const TOOL_DEFS = [
  {
    name: 'reschedule_task',
    description:
      'Move a task to a new due date. Use when the user asks to reschedule, move, push, ' +
      'postpone, delay, or snooze a specific task to a day. Only use a task_id from the ' +
      'provided task list.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id of the task, taken from the provided task list.' },
        new_due_date: { type: 'string', description: 'The new due date, formatted YYYY-MM-DD.' },
      },
      required: ['task_id', 'new_due_date'],
    },
  },
  {
    name: 'mark_task_done',
    description:
      'Mark a task complete. Use when the user clearly says they finished or completed a ' +
      'specific task. Only use a task_id from the provided task list.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id of the task, taken from the provided task list.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'draft_and_send_email',
    description:
      'Draft an email to send on the user\'s behalf. Use when the user asks you to email, ' +
      'reply to, or message someone. You MUST have a real recipient email address — if the ' +
      'user has not given one, do NOT call this tool; ask them for the address first. Write a ' +
      'complete, warm, natural draft (the user will review and can edit before it sends).',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: "The recipient's email address. Must be a real address the user provided." },
        subject: { type: 'string', description: 'A clear, short subject line.' },
        body: { type: 'string', description: 'The full email body, ready to send. Plain text; use line breaks for paragraphs.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

const TIERS = { reschedule_task: 'auto', mark_task_done: 'auto', draft_and_send_email: 'confirm' };

// Where an action takes effect, surfaced to the user so there's never any
// confusion: 'app' = only inside FocusLedger's own data (reversible, no
// external side effect); 'world' = a real-world side effect (e.g. sending an
// email) that must be labelled distinctly. Stage 1 is all 'app'.
const SCOPES = { reschedule_task: 'app', mark_task_done: 'app', draft_and_send_email: 'world' };

function tierOf(name) { return TIERS[name] || null; }
function scopeOf(name) { return SCOPES[name] || 'app'; }
function isKnown(name) { return Object.prototype.hasOwnProperty.call(TIERS, name); }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Execute one tool. Trusts that the caller has resolved the tier; throws only
 * on unexpected DB errors (the route logs them). Expected failures (bad input,
 * task not found) come back as { ok:false, error }.
 * @returns {Promise<{ok:boolean, result?:object, receipt?:string, undo?:object|null, error?:string}>}
 */
async function dispatch(pool, userId, name, input) {
  input = input || {};
  switch (name) {
    case 'reschedule_task': {
      const { task_id, new_due_date } = input;
      if (!task_id) return { ok: false, error: 'No task specified.' };
      if (!ISO_DATE.test(String(new_due_date || ''))) return { ok: false, error: 'Invalid date.' };
      const prev = await pool.query(
        `SELECT title, due_date FROM tasks WHERE id = $1 AND user_id = $2`,
        [task_id, userId]
      );
      if (!prev.rows.length) return { ok: false, error: 'Task not found.' };
      const prevDue = prev.rows[0].due_date;
      const upd = await pool.query(
        `UPDATE tasks SET due_date = $1 WHERE id = $2 AND user_id = $3 RETURNING title`,
        [new_due_date, task_id, userId]
      );
      const title = upd.rows[0].title;
      return {
        ok: true,
        result: { task_id, title, new_due_date },
        receipt: `Moved “${title}” to ${new_due_date}`,
        undo: { tool: 'reschedule_task', task_id, due_date: prevDue },
      };
    }

    case 'mark_task_done': {
      const { task_id } = input;
      if (!task_id) return { ok: false, error: 'No task specified.' };
      const cur = await pool.query(
        `SELECT title, is_completed FROM tasks WHERE id = $1 AND user_id = $2`,
        [task_id, userId]
      );
      if (!cur.rows.length) return { ok: false, error: 'Task not found.' };
      if (cur.rows[0].is_completed) {
        return { ok: true, result: { task_id, title: cur.rows[0].title }, receipt: `“${cur.rows[0].title}” was already done`, undo: null };
      }
      const upd = await pool.query(
        `UPDATE tasks SET is_completed = true, completed_at = NOW()
          WHERE id = $1 AND user_id = $2 AND is_completed = false RETURNING title`,
        [task_id, userId]
      );
      const title = upd.rows[0].title;
      return {
        ok: true,
        result: { task_id, title },
        receipt: `Marked “${title}” done`,
        undo: { tool: 'mark_task_done', task_id },
      };
    }

    case 'draft_and_send_email': {
      const to = String(input.to || '').trim();
      const subject = String(input.subject || '').trim();
      const body = String(input.body || '').trim();
      if (!EMAIL_RE.test(to)) return { ok: false, error: 'That doesn’t look like a valid email address.' };
      if (!subject) return { ok: false, error: 'The email needs a subject.' };
      if (!body) return { ok: false, error: 'The email is empty.' };

      // Reply-to + CC the user's own address so replies reach them and they
      // keep a copy. Send from the verified FocusLedger domain.
      const u = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      const userEmail = u.rows[0] && u.rows[0].email;
      if (!userEmail) return { ok: false, error: 'Could not find your account email to send on your behalf.' };

      const { sendEmail } = require('./emailService');
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;white-space:pre-wrap">${escapeHtml(body)}</div>`;
      const result = await sendEmail(pool, {
        userId, to, subject, html,
        replyTo: userEmail,
        cc: userEmail,
        templateType: 'agent_outbound',
      });
      if (!result || !result.success) {
        return { ok: false, error: (result && result.error) || 'The email could not be sent.' };
      }
      return {
        ok: true,
        result: { to, subject, email_id: result.id || null },
        receipt: `Emailed ${to}`,
        undo: null, // outward send — reversal is CC + the review gate, not an undo
      };
    }

    default:
      return { ok: false, error: `Unknown action: ${name}` };
  }
}

/**
 * Reverse an executed action from its stored undo_token.
 * @returns {Promise<{ok:boolean, summary?:string, error?:string}>}
 */
async function reverse(pool, userId, actionRow) {
  const undo = actionRow && actionRow.undo_token;
  if (!undo || !undo.tool) return { ok: false, error: 'Nothing to undo.' };
  switch (undo.tool) {
    case 'reschedule_task':
      await pool.query(
        `UPDATE tasks SET due_date = $1 WHERE id = $2 AND user_id = $3`,
        [undo.due_date || null, undo.task_id, userId]
      );
      return { ok: true, summary: 'Put the due date back' };
    case 'mark_task_done':
      await pool.query(
        `UPDATE tasks SET is_completed = false, completed_at = NULL WHERE id = $1 AND user_id = $2`,
        [undo.task_id, userId]
      );
      return { ok: true, summary: 'Un-completed it' };
    default:
      return { ok: false, error: 'Nothing to undo.' };
  }
}

module.exports = { TOOL_DEFS, TIERS, SCOPES, tierOf, scopeOf, isKnown, dispatch, reverse };
