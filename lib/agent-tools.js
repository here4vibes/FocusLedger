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
    name: 'create_task',
    description:
      'Create a new task, optionally with a due date/time and recurrence. Use when the user asks ' +
      'to add a task, remind them to do something, or nudge them — including repeating ones. ' +
      'FocusLedger pushes a notification when a task with a due date/time is within an hour of due ' +
      'or overdue — so a due-dated task IS the reminder. For "remind me tomorrow evening", set ' +
      'tomorrow\'s date + a time like 18:00. For a REPEATING nudge set recurrence: "clean the ' +
      'kitchen every night at 8:15" → due_date today, due_time 20:15, recurrence "daily"; "every ' +
      'weekday" → "weekdays"; "every Monday" → "weekly" + recurrence_day 1; "monthly" → "monthly". ' +
      'The push only fires for a task that has BOTH a due_date AND a due_time, so always include ' +
      'due_date (use today for a nightly reminder). A recurring task re-spawns when completed. ' +
      'Only promise a nudge/recurrence you actually set here — never claim a schedule you did not create.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, e.g. "Clean the kitchen".' },
        due_date: { type: 'string', description: 'Optional due date, formatted YYYY-MM-DD.' },
        due_time: { type: 'string', description: 'Optional due time in 24h HH:MM, e.g. "20:15".' },
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'],
          description: 'Optional repeat. "daily" = every day/night; "weekdays" = Mon–Fri.',
        },
        recurrence_day: {
          type: 'integer',
          description: 'For "weekly": day of week 0=Sun..6=Sat. For "monthly": day of month 1–31.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description:
      'Change an EXISTING task — set or clear its due date, due time, or recurrence. Use when the ' +
      'user wants to modify a task already on their list, e.g. "the clean kitchen task should be ' +
      'nightly" → update_task on that task with recurrence "daily"; "make the rent reminder monthly"; ' +
      '"add 8:15pm to the tub task". Identify the task by matching its title to the open-tasks list ' +
      'and pass its id — never create a duplicate for a change. Same nudge rule as create_task: a ' +
      'push fires only when the task ends up with BOTH a due date and a due time. Report only the ' +
      'change you actually made.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'The id of the task to change, from the open-tasks list.' },
        due_date: { type: 'string', description: 'New due date YYYY-MM-DD (omit to leave unchanged).' },
        due_time: { type: 'string', description: 'New due time HH:MM 24h (omit to leave unchanged).' },
        recurrence: {
          type: 'string',
          enum: ['none', 'daily', 'weekdays', 'weekly', 'monthly'],
          description: 'New repeat (omit to leave unchanged; "none" clears it). "daily" = every day/night.',
        },
        recurrence_day: { type: 'integer', description: 'For "weekly": 0=Sun..6=Sat. For "monthly": 1–31.' },
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

const TIERS = { reschedule_task: 'auto', mark_task_done: 'auto', create_task: 'auto', update_task: 'auto', draft_and_send_email: 'confirm' };

// Where an action takes effect, surfaced to the user so there's never any
// confusion: 'app' = only inside FocusLedger's own data (reversible, no
// external side effect); 'world' = a real-world side effect (e.g. sending an
// email) that must be labelled distinctly. Stage 1 is all 'app'.
const SCOPES = { reschedule_task: 'app', mark_task_done: 'app', create_task: 'app', update_task: 'app', draft_and_send_email: 'world' };

function tierOf(name) { return TIERS[name] || null; }
function scopeOf(name) { return SCOPES[name] || 'app'; }
function isKnown(name) { return Object.prototype.hasOwnProperty.call(TIERS, name); }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// node-postgres returns DATE columns as JS Date objects. Format to YYYY-MM-DD
// using LOCAL fields (not toISOString, which would shift across the tz boundary),
// so an undo token round-trips the original day exactly.
function dateToYMD(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
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

    case 'create_task': {
      const title = String(input.title || '').trim();
      if (!title) return { ok: false, error: 'What should the task be?' };
      const dueDate = ISO_DATE.test(String(input.due_date || '')) ? input.due_date : null;
      const dueTime = TIME_RE.test(String(input.due_time || '')) ? input.due_time : null;
      const RECUR = new Set(['none', 'daily', 'weekdays', 'weekly', 'monthly']);
      const recType = RECUR.has(input.recurrence) ? input.recurrence : 'none';
      // recurrence_day only meaningful for weekly (0-6) / monthly (1-31)
      const recDay = (recType === 'weekly' || recType === 'monthly') && Number.isInteger(input.recurrence_day)
        ? input.recurrence_day : null;
      const ins = await pool.query(
        `INSERT INTO tasks (user_id, title, due_date, due_time, priority, recurrence_type, recurrence_day, is_completed, created_at)
         VALUES ($1, $2, $3::date, $4::time, 'medium', $5, $6, false, NOW())
         RETURNING id, title`,
        [userId, title.slice(0, 200), dueDate, dueTime, recType, recDay]
      );
      const t = ins.rows[0];
      const RECUR_LABEL = { daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month' };
      let when = '';
      if (RECUR_LABEL[recType]) {
        when = RECUR_LABEL[recType] + (dueTime ? ` at ${dueTime}` : '');       // "every day at 20:15"
      } else if (dueDate) {
        when = `for ${dueDate}${dueTime ? ' ' + dueTime : ''}`;                // "for 2026-10-05 20:15"
      }
      // Only promise a nudge when both a date and a time exist — that's exactly
      // what the deadline-nudge cron needs. Never over-promise a reminder.
      const nudge = (dueDate && dueTime) ? ' — I’ll nudge you when it’s due' : '';
      return {
        ok: true,
        result: { task_id: t.id, title: t.title, due_date: dueDate, due_time: dueTime, recurrence: recType },
        receipt: `Added “${t.title}”${when ? ' ' + when : ''}${nudge}`,
        undo: { tool: 'create_task', task_id: t.id },
      };
    }

    case 'update_task': {
      const taskId = input.task_id;
      if (!taskId) return { ok: false, error: 'Which task? I need its id.' };
      const cur = await pool.query(
        `SELECT title, due_date, due_time, recurrence_type, recurrence_day
           FROM tasks WHERE id = $1 AND user_id = $2`,
        [taskId, userId]
      );
      if (!cur.rows.length) return { ok: false, error: 'Task not found.' };
      const before = cur.rows[0];

      const RECUR = new Set(['none', 'daily', 'weekdays', 'weekly', 'monthly']);
      const RECUR_LABEL = { none: 'one-time', daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month' };
      const sets = [], vals = [], changed = [];
      let i = 1;

      if (input.due_date !== undefined) {
        const d = ISO_DATE.test(String(input.due_date || '')) ? input.due_date : null;
        sets.push(`due_date = $${i++}::date`); vals.push(d);
        changed.push(d ? `due ${d}` : 'no due date');
      }
      if (input.due_time !== undefined) {
        const tm = TIME_RE.test(String(input.due_time || '')) ? input.due_time : null;
        sets.push(`due_time = $${i++}::time`); vals.push(tm);
        if (tm) changed.push(`at ${tm}`);
      }
      if (input.recurrence !== undefined) {
        const rt = RECUR.has(input.recurrence) ? input.recurrence : 'none';
        const rd = (rt === 'weekly' || rt === 'monthly') && Number.isInteger(input.recurrence_day) ? input.recurrence_day : null;
        sets.push(`recurrence_type = $${i++}`); vals.push(rt);
        sets.push(`recurrence_day = $${i++}`); vals.push(rd);
        changed.push(RECUR_LABEL[rt]);
      }
      if (!sets.length) return { ok: false, error: 'Nothing to change — tell me what to set.' };

      vals.push(taskId, userId);
      await pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i}`, vals);

      // Only promise a nudge if the task ends up with BOTH a date and a time.
      const finalDate = input.due_date !== undefined ? (ISO_DATE.test(String(input.due_date || '')) ? input.due_date : null) : before.due_date;
      const finalTime = input.due_time !== undefined ? (TIME_RE.test(String(input.due_time || '')) ? input.due_time : null) : before.due_time;
      const nudge = (finalDate && finalTime) ? ' — I’ll nudge you when it’s due' : '';

      return {
        ok: true,
        result: { task_id: taskId, title: before.title },
        receipt: `Updated “${before.title}”${changed.length ? ' — ' + changed.join(', ') : ''}${nudge}`,
        undo: {
          tool: 'update_task', task_id: taskId,
          due_date: dateToYMD(before.due_date), due_time: before.due_time,
          recurrence_type: before.recurrence_type, recurrence_day: before.recurrence_day,
        },
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
    case 'create_task':
      await pool.query(
        `DELETE FROM tasks WHERE id = $1 AND user_id = $2`,
        [undo.task_id, userId]
      );
      return { ok: true, summary: 'Removed that task' };
    case 'update_task':
      await pool.query(
        `UPDATE tasks SET due_date = $1::date, due_time = $2::time, recurrence_type = $3, recurrence_day = $4
          WHERE id = $5 AND user_id = $6`,
        [undo.due_date || null, undo.due_time || null,
         undo.recurrence_type || 'none', undo.recurrence_day != null ? undo.recurrence_day : null,
         undo.task_id, userId]
      );
      return { ok: true, summary: 'Reverted that change' };
    default:
      return { ok: false, error: 'Nothing to undo.' };
  }
}

module.exports = { TOOL_DEFS, TIERS, SCOPES, tierOf, scopeOf, isKnown, dispatch, reverse };
