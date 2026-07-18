// routes/agent.js — Cowork Stage 1: Buddy executes actions on the user's behalf.
// Owns: /api/agent/* (act, undo). See docs/cowork-stage1-spec.md.
// Does NOT own: the tool implementations (lib/agent-tools.js), the ledger SQL
// (db/agent-actions.js), or the conversational/coaching path (routes/buddy.js).

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { completeWithTools } = require('../lib/claude-client');
const { TOOL_DEFS, tierOf, scopeOf, isKnown, dispatch, reverse } = require('../lib/agent-tools');
const { logAction, getAction, markUndone } = require('../db/agent-actions');

function buildSystemPrompt(today, tasks) {
  const list = tasks.length
    ? tasks.map(t => `- id=${t.id} · "${t.title}"${t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : ' (no due date)'}`).join('\n')
    : '(no open tasks)';
  return [
    "You are Buddy, the user's calm, warm ADHD companion inside FocusLedger.",
    `Today is ${today}.`,
    'You can TAKE ACTIONS on the user\'s tasks using the provided tools — but only when',
    'they clearly ask you to (reschedule/move/postpone a task, or mark one done).',
    'When you take an action, also reply with one short, warm sentence confirming it.',
    'If they are just talking, thinking, or asking a question, DO NOT call a tool — just reply briefly.',
    'Never invent a task_id; only use ids from this list. If you cannot find the task they mean, ask which one.',
    '',
    "The user's open tasks:",
    list,
  ].join('\n');
}

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ── POST /api/agent/act ─────────────────────────────────────────────────────
  // { message } → Buddy replies and, if asked, executes 'auto' task actions.
  router.post('/act', async (req, res) => {
    try {
      const userId = req.user.id;
      const { message } = req.body;
      if (!message || !message.trim()) {
        return res.status(400).json({ success: false, message: 'message required' });
      }

      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);
      const tasksResult = await pool.query(
        `SELECT id, title, due_date FROM tasks
          WHERE user_id = $1 AND is_completed = false
          ORDER BY due_date ASC NULLS LAST, created_at ASC LIMIT 50`,
        [userId]
      );
      const tasks = tasksResult.rows;

      let resp;
      try {
        resp = await completeWithTools({
          system: buildSystemPrompt(today, tasks),
          messages: [{ role: 'user', content: message.trim() }],
          tools: TOOL_DEFS,
          model: 'claude-sonnet-4-6',
          maxTokens: 700,
        });
      } catch (aiErr) {
        console.error('[Agent] act AI error:', aiErr.message, '| userId:', userId);
        return res.json({ success: true, reply: "I couldn't think that through just now — mind trying again?", receipts: [] });
      }

      const blocks = Array.isArray(resp.content) ? resp.content : [];
      const reply = blocks.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      const toolUses = blocks.filter(b => b.type === 'tool_use');

      const receipts = [];
      let confirmation = null;

      for (const tu of toolUses) {
        if (!isKnown(tu.name)) {
          console.warn('[Agent] model proposed unknown tool:', tu.name, '| userId:', userId);
          continue;
        }
        const tier = tierOf(tu.name);

        if (tier === 'confirm') {
          // Stage 1.4: never auto-run — log as proposed and return a confirmation card.
          const row = await logAction(pool, {
            userId, actionType: tu.name, status: 'proposed', riskTier: 'confirm', params: tu.input || {},
          });
          confirmation = { id: row.id, action_type: tu.name, params: tu.input || {} };
          break; // one confirmation at a time
        }

        // tier === 'auto': execute now.
        try {
          const out = await dispatch(pool, userId, tu.name, tu.input || {});
          if (out.ok) {
            const row = await logAction(pool, {
              userId, actionType: tu.name, status: 'executed', riskTier: 'auto',
              params: tu.input || {}, result: out.result || null, undoToken: out.undo || null,
            });
            receipts.push({ id: row.id, summary: out.receipt, undoable: !!out.undo, ok: true, scope: scopeOf(tu.name) });
          } else {
            await logAction(pool, {
              userId, actionType: tu.name, status: 'failed', riskTier: 'auto',
              params: tu.input || {}, error: out.error || 'unknown',
            });
            receipts.push({ id: null, summary: out.error || "I couldn't do that one", undoable: false, ok: false, scope: scopeOf(tu.name) });
          }
        } catch (dispErr) {
          console.error('[Agent] dispatch failed:', dispErr.message, '| tool:', tu.name, '| userId:', userId);
          await logAction(pool, {
            userId, actionType: tu.name, status: 'failed', riskTier: 'auto',
            params: tu.input || {}, error: dispErr.message,
          }).catch(() => {});
          receipts.push({ id: null, summary: "Something broke doing that — nothing changed", undoable: false, ok: false, scope: scopeOf(tu.name) });
        }
      }

      res.json({ success: true, reply, receipts, confirmation });
    } catch (err) {
      console.error('[Agent] POST /act error:', err.message, '| userId:', req.user && req.user.id);
      res.status(500).json({ success: false, message: 'Agent failed' });
    }
  });

  // ── POST /api/agent/undo ────────────────────────────────────────────────────
  // { action_id } → reverse an executed action. Idempotent.
  router.post('/undo', async (req, res) => {
    try {
      const userId = req.user.id;
      const actionId = parseInt(req.body.action_id, 10);
      if (!actionId) return res.status(400).json({ success: false, message: 'action_id required' });

      const action = await getAction(pool, actionId, userId);
      if (!action) return res.status(404).json({ success: false, message: 'Action not found' });
      if (action.status !== 'executed') {
        return res.json({ success: true, alreadyUndone: true, message: 'Nothing to undo' });
      }

      const rev = await reverse(pool, userId, action);
      if (!rev.ok) return res.status(400).json({ success: false, message: rev.error || 'Cannot undo' });

      await markUndone(pool, actionId, userId);
      res.json({ success: true, summary: rev.summary });
    } catch (err) {
      console.error('[Agent] POST /undo error:', err.message, '| userId:', req.user && req.user.id);
      res.status(500).json({ success: false, message: 'Undo failed' });
    }
  });

  return router;
};
