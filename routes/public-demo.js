'use strict';
// Owns: the no-account "Break It Down" demo on the landing page — the
// instant-magic-before-signup funnel (Goblin Tools' superpower, aimed back).
// Does NOT own: authenticated task breakdown (routes/buddy.js) or task CRUD.
const express = require('express');
const rateLimit = require('express-rate-limit');

// Hard spend guards: this endpoint is unauthenticated by design.
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5, // 5 breakdowns per IP per hour — enough to fall in love, not to farm
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'That’s the demo limit for now — sign up (free) for unlimited breakdowns.' },
});

// Belt + braces: absolute daily cap across ALL IPs so a botnet can't run up
// the AI bill. Resets on process restart / day rollover.
let dailyCount = 0;
let dailyDate = '';
function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyDate) { dailyDate = today; dailyCount = 0; }
  return dailyCount < 500;
}

const SYSTEM_PROMPT = `You are the task-breakdown engine for FocusLedger, an ADHD-native app. A visitor (not logged in) pasted something that feels overwhelming. Break it into 4-7 tiny, concrete, immediately-startable steps.

Rules:
- First step must be trivially small — startable in under 2 minutes (the activation-energy killer).
- Each step is ONE physical or digital action, max ~10 words.
- No motivational fluff, no "take a deep breath" — real steps only.
- If the input is not a task (gibberish, a question, offensive content), return an empty array.

Return ONLY a JSON array of strings, no other text:
["step one", "step two", ...]`;

module.exports = function () {
  const router = express.Router();

  // POST /api/public/breakdown  { task: string }
  router.post('/breakdown', demoLimiter, async (req, res) => {
    try {
      const task = String(req.body?.task || '').trim().slice(0, 200);
      if (task.length < 5) {
        return res.status(400).json({ success: false, message: 'Tell me the task first — a few words is plenty.' });
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ success: false, message: 'Demo is warming up — try again in a minute.' });
      }
      if (!underDailyCap()) {
        console.warn('[public-demo] daily cap reached — refusing further breakdowns today');
        return res.status(429).json({ success: false, message: 'The demo is very popular today — sign up (free) for the full version.' });
      }

      const { complete } = require('../lib/claude-client');
      const text = await complete({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Task: ${task}` }],
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 250,
      });

      let steps = [];
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          steps = JSON.parse(match[0])
            .filter(s => typeof s === 'string' && s.trim().length > 0)
            .slice(0, 7)
            .map(s => s.trim().slice(0, 120));
        } catch { /* fall through to empty */ }
      }
      if (!steps.length) {
        return res.status(422).json({ success: false, message: 'Couldn’t break that one down — try phrasing it as a task ("clean the garage").' });
      }

      dailyCount++;
      res.json({ success: true, steps });
    } catch (err) {
      console.error('[public-demo] breakdown failed:', err.message);
      res.status(500).json({ success: false, message: 'Something hiccuped — try again.' });
    }
  });

  return router;
};
