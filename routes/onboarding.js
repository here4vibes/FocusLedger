'use strict';
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { chatMessages } = require('../lib/polsia-ai');
const { updateAdhdProfile } = require('../lib/adhd-profile');

const ONBOARDING_SYSTEM_PROMPT = `You are Buddy — an ADHD coaching companion built into FocusLedger.

You're meeting a new user for the very first time. Your job in this conversation:
1. Make them feel like they came to the right place
2. Understand what's actually hard in their life right now (one primary struggle area)
3. Surface one concrete task or commitment they're already aware of but haven't tackled
4. Learn when they tend to have more energy (morning, afternoon, or evening)
5. Ask if they'd like a morning nudge from Buddy each day — asked last, after you've connected

Your voice: direct, warm, genuinely curious. Not clinical, not over-enthusiastic. Like a sharp person who actually gets ADHD — because they do.

Rules:
- Ask ONE question per message — never stack questions
- Keep responses to 2-3 sentences
- Follow the human's energy — if they go somewhere interesting, go with them
- Don't explain what FocusLedger does — show by asking
- Don't say "Great!" or "I hear you" or any filler affirmation
- This is a "tell me about your life" conversation, not a check-in
- Ask about morning nudges last, phrased naturally — e.g. "One last thing — want me to check in with you tomorrow morning? I can send a nudge so you don't have to remember to come back."

When you've gathered all four things (struggle area, one concrete task, energy pattern, notification preference), wrap up warmly, tell them their space is being set up, and end your message with — on its own line:
[[ONBOARDING_COMPLETE]]
{"tasks":[{"title":"...","priority":"high"}],"struggle_area":"...","peak_energy":"...","wants_notifications":true}

Rules for the JSON payload:
- tasks: 1-3 concrete, actionable tasks based on what they mentioned (titles under 60 chars)
- struggle_area: one of: work, money, home, health, focus, relationships, other
- peak_energy: one of: morning, afternoon, evening (null if they didn't say)
- wants_notifications: true if they said yes to morning nudges, false otherwise
- The JSON must be valid and on the line immediately after [[ONBOARDING_COMPLETE]]`;

module.exports = function (pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/onboarding/status — has this user completed onboarding?
  router.get('/status', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT onboarding_completed_at FROM users WHERE id = $1',
        [req.user.id]
      );
      const done = !!result.rows[0]?.onboarding_completed_at;
      res.json({ success: true, needsOnboarding: !done });
    } catch (err) {
      console.error('[onboarding] GET /status error:', err.message);
      res.json({ success: true, needsOnboarding: false }); // safe default: don't force loop
    }
  });

  // POST /api/onboarding/conversation — one turn of the onboarding chat
  router.post('/conversation', async (req, res) => {
    try {
      const { message, history = [] } = req.body;
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, message: 'message required' });
      }

      const contextHistory = history.map((h) => ({
        role: h.role === 'buddy' ? 'assistant' : 'user',
        content: h.content,
      }));
      contextHistory.push({ role: 'user', content: message.trim() });

      const raw = await chatMessages(contextHistory, {
        system: ONBOARDING_SYSTEM_PROMPT,
        maxTokens: 400,
        model: 'claude-sonnet-4-6',
      });

      const completeIdx = raw.indexOf('[[ONBOARDING_COMPLETE]]');
      let reply = raw;
      let isComplete = false;
      let seedPayload = null;

      if (completeIdx !== -1) {
        isComplete = true;
        reply = raw.slice(0, completeIdx).trim();
        const jsonLine = raw.slice(completeIdx + '[[ONBOARDING_COMPLETE]]'.length).trim();
        try {
          seedPayload = JSON.parse(jsonLine.match(/\{[\s\S]*\}/)?.[0] || '{}');
        } catch {
          seedPayload = {};
        }
      }

      res.json({ success: true, reply, isComplete, seedPayload });
    } catch (err) {
      console.error('[onboarding] POST /conversation error:', err.message);
      res.status(500).json({ success: false, message: 'Conversation failed' });
    }
  });

  // POST /api/onboarding/complete — seed app data, mark onboarding done
  router.post('/complete', async (req, res) => {
    try {
      const userId = req.user.id;
      const { tasks = [], struggle_area, peak_energy, conversationHistory = [] } = req.body;

      // Create seeded tasks
      for (const t of tasks) {
        if (!t.title || typeof t.title !== 'string') continue;
        const priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
        await pool.query(
          `INSERT INTO tasks (title, priority, user_id, source) VALUES ($1, $2, $3, 'onboarding')`,
          [t.title.slice(0, 200), priority, userId]
        );
      }

      // Mark onboarding complete
      await pool.query(
        'UPDATE users SET onboarding_completed_at = NOW() WHERE id = $1',
        [userId]
      );

      // Build initial ADHD profile from onboarding conversation (fire-and-forget)
      if (conversationHistory.length > 0) {
        setImmediate(async () => {
          try {
            const msgs = conversationHistory.map((h) => ({
              role: h.role === 'buddy' ? 'assistant' : 'user',
              content: h.content,
            }));
            // Manually merge struggle_area + peak_energy from seed payload into profile
            await updateAdhdProfile(pool, userId, msgs);
            if (struggle_area || peak_energy) {
              const existing = (await pool.query('SELECT adhd_profile FROM users WHERE id = $1', [userId])).rows[0]?.adhd_profile || {};
              const merged = {
                ...existing,
                ...(struggle_area && !existing.struggle_area ? { struggle_area } : {}),
                ...(peak_energy && !existing.peak_energy ? { peak_energy } : {}),
              };
              await pool.query('UPDATE users SET adhd_profile = $1 WHERE id = $2', [JSON.stringify(merged), userId]);
            }
          } catch { /* non-blocking */ }
        });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[onboarding] POST /complete error:', err.message);
      res.status(500).json({ success: false, message: 'Setup failed' });
    }
  });

  return router;
};
