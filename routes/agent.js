// routes/agent.js — Cowork Stage 1: Buddy executes actions on the user's behalf.
// Owns: /api/agent/* (act, undo). See docs/cowork-stage1-spec.md.
// Does NOT own: the tool implementations (lib/agent-tools.js), the ledger SQL
// (db/agent-actions.js), or the conversational/coaching path (routes/buddy.js).

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { fetchUserTimezone, getUserLocalDate } = require('../lib/timezone');
const { completeWithTools } = require('../lib/claude-client');
const { TOOL_DEFS, tierOf, scopeOf, isKnown, dispatch, reverse } = require('../lib/agent-tools');
const { logAction, getAction, markUndone, markExecuted, markCancelled, markFailed, recentActionCount } = require('../db/agent-actions');
const { checkProStatus } = require('../middleware/proUtils');

// Daily cap on real-world sends per user (guardrail; see spec).
const DAILY_SEND_CAP = 20;

// Shape a proposed confirm-tier action into a card the client can render.
function buildConfirmation(row, name, input) {
  if (name === 'draft_and_send_email') {
    return {
      id: row.id, action_type: name, scope: 'world',
      title: 'Send this email?',
      preview: { to: input.to || '', subject: input.subject || '', body: input.body || '' },
      editable: ['subject', 'body'],
      confirmLabel: 'Send it', cancelLabel: 'Not yet',
    };
  }
  return { id: row.id, action_type: name, scope: scopeOf(name), params: input || {} };
}

function buildSystemPrompt(today, tasks) {
  const list = tasks.length
    ? tasks.map(t => `- id=${t.id} · "${t.title}"${t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : ' (no due date)'}`).join('\n')
    : '(no open tasks)';
  return [
    "You are Buddy, the user's warm, calm ADHD companion inside FocusLedger.",
    `Today is ${today}.`,
    '',
    'You can take real actions for the user with your tools:',
    '• reschedule a task  • mark a task done  • draft AND send an email on their behalf.',
    'These are real capabilities you HAVE — never say you cannot send email or change tasks.',
    'If you are missing something you need (a recipient email address, or which task they',
    'mean), ask ONE short question to get it, then take the action on the next turn.',
    '',
    "Use a tool ONLY when the user is clearly asking you to do that thing. When they're just",
    "talking, thinking, or venting, don't call a tool — reply briefly and warmly.",
    'When you send an email, write a complete, natural draft — the user reviews it before it goes.',
    'Never invent a task_id or an email address: use only ids from the list below, and only',
    'real addresses the user has given you.',
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

      // Conversation context is supplied by the client (the visible thread) —
      // no extra DB writes in the hot path, and no dependency on another table's
      // prod schema. This is what makes multi-turn actions work ("email Miles" →
      // ask for the address → send). Sanitised and capped.
      const clientHistory = Array.isArray(req.body.history) ? req.body.history : [];
      const contextHistory = clientHistory
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
        .slice(-16)
        .map(h => ({ role: h.role, content: h.content.trim().slice(0, 2000) }));
      contextHistory.push({ role: 'user', content: message.trim() });

      let resp;
      try {
        resp = await completeWithTools({
          system: buildSystemPrompt(today, tasks),
          messages: contextHistory,
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
          // Never auto-run — log as proposed and return a confirmation card.
          // Resilient: a logging failure must not crash the whole reply.
          try {
            const row = await logAction(pool, {
              userId, actionType: tu.name, status: 'proposed', riskTier: 'confirm', params: tu.input || {},
            });
            confirmation = buildConfirmation(row, tu.name, tu.input || {});
          } catch (logErr) {
            console.error('[Agent] proposing action failed:', logErr.message, '| tool:', tu.name, '| userId:', userId);
            receipts.push({ id: null, summary: "I put that together but couldn't set up the send just now — try once more?", undoable: false, ok: false, scope: scopeOf(tu.name) });
          }
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

  // ── POST /api/agent/confirm ─────────────────────────────────────────────────
  // { action_id, subject?, body?, cancel? } → execute (or cancel) a proposed
  // confirm-tier action. Outward (world) actions are paid-gated. Idempotent.
  router.post('/confirm', async (req, res) => {
    try {
      const userId = req.user.id;
      const actionId = parseInt(req.body.action_id, 10);
      if (!actionId) return res.status(400).json({ success: false, message: 'action_id required' });

      const action = await getAction(pool, actionId, userId);
      if (!action) return res.status(404).json({ success: false, message: 'Action not found' });

      if (req.body.cancel) {
        await markCancelled(pool, actionId, userId);
        return res.json({ success: true, cancelled: true });
      }
      if (action.status !== 'proposed') {
        return res.json({ success: true, alreadyDone: true }); // idempotent — no double send
      }

      const scope = scopeOf(action.action_type);

      // Paid gate: real-world execution is an Autopilot feature.
      if (scope === 'world') {
        const isPro = await checkProStatus(pool, userId).catch(() => false);
        if (!isPro) {
          return res.status(402).json({
            success: false, upsell: true, feature: 'Sending on your behalf',
            message: "Drafting is free — but sending it for you is an Autopilot feature.",
          });
        }
        const sentToday = await recentActionCount(pool, userId, action.action_type, '1 day').catch(() => 0);
        if (sentToday >= DAILY_SEND_CAP) {
          return res.status(429).json({ success: false, message: "That's today's send limit — try again tomorrow." });
        }
      }

      // Apply any edits the user made in the confirmation card.
      const params = Object.assign({}, action.params || {});
      if (typeof req.body.subject === 'string') params.subject = req.body.subject;
      if (typeof req.body.body === 'string') params.body = req.body.body;

      let out;
      try {
        out = await dispatch(pool, userId, action.action_type, params);
      } catch (dispErr) {
        console.error('[Agent] confirm dispatch threw:', dispErr.message, '| action:', actionId, '| userId:', userId);
        await markFailed(pool, actionId, userId, dispErr.message).catch(() => {});
        return res.status(500).json({ success: false, message: 'That failed to send — nothing went out.' });
      }

      if (!out.ok) {
        await markFailed(pool, actionId, userId, out.error);
        return res.status(400).json({ success: false, message: out.error || 'Could not complete that.' });
      }

      await markExecuted(pool, actionId, userId, out.result || null);
      res.json({ success: true, receipt: { id: actionId, summary: out.receipt, undoable: !!out.undo, ok: true, scope } });
    } catch (err) {
      console.error('[Agent] POST /confirm error:', err.message, '| userId:', req.user && req.user.id);
      res.status(500).json({ success: false, message: 'Confirm failed' });
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
