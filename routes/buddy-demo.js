// Owns: anonymous Buddy demo endpoints for the landing page.
// No auth required. Rate-limited to 10 messages per session token.
// Does NOT own: authenticated Buddy check-in, task CRUD, user management.
//
// Endpoints:
//   POST /api/buddy-demo/conversation  — send one message, get Buddy reply
//   GET  /api/buddy-demo/session/:token — retrieve session data (for account hydration)

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { chatMessages } = require('../lib/polsia-ai');
const {
  MAX_MESSAGES_PER_SESSION,
  getOrCreateSession,
  getTurns,
  insertTurn,
  updateSessionInsights,
  getSessionData,
  isRateLimited
} = require('../db/buddy-demo');

// IP-based rate limiter — 60 requests per 15 min from one IP to prevent bulk abuse.
// Per-session limit (10 messages) is enforced separately in the handler.
const demoIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, try again later.' }
});

// ── Demo system prompt ────────────────────────────────────────────────────────
// Same coaching philosophy as the authenticated flow but adapted for strangers
// who haven't signed up yet. Warmer intro, no task history context.
function buildDemoSystemPrompt(userTurnNumber) {
  const base = `You are Buddy — an ADHD coaching assistant inside FocusLedger. You follow The Coaching Habit framework.
Your style: warm, direct, no fluff. Short sentences. No "Great question!" or sycophancy.
You never shame. You never force positivity. You meet people where they are.
Keep responses under 70 words. Ask ONE question at a time.
This is a LIVE DEMO — the person hasn't signed up yet. You're showing them what real coaching feels like.
React to what they actually say. Don't pitch the product. Just be useful.`;

  if (userTurnNumber === 1) {
    return base + `\n\nThis is the opening turn with someone exploring FocusLedger for the first time.
Do NOT ask "How are you feeling?" or "What's on your mind today?" — those are generic.
Instead, try: "What's actually taking up space in your head right now?" or "What's the one thing you keep putting off?"
Be human, not a chatbot. If they already gave you context in their first message, respond to what they said — don't ask an opener question.`;
  } else if (userTurnNumber === 2) {
    return base + `\n\nSecond exchange. If they're venting or overwhelmed, acknowledge that first.
Focus their thinking: "Is there one thing underneath all of this?" or "What's the part that's actually stressing you out?"
Don't skip to solutions.`;
  } else if (userTurnNumber === 3) {
    return base + `\n\nThird exchange. Help them land on something concrete — one thing they actually want to do today.
Phrase it as a question. Validate something specific they said.`;
  } else if (userTurnNumber >= 4) {
    // After 4+ turns, gently nudge toward signup — woven naturally into the wrap-up
    return base + `\n\nThis person has been chatting for a while. Wrap up warmly. Name the key thing they want to focus on.
If it feels natural, mention that FocusLedger can track this for them — but don't pitch. Keep it human.
End your message with exactly "[[DEMO_COMPLETE]]" on its own line after your closing words.`;
  }
  return base;
}

// Infer mood from conversation text (same logic as authenticated flow).
function inferMoodFromText(messages) {
  const text = messages.map(m => m.message || '').join(' ').toLowerCase();
  if (/overwhelm|anxious|anxiety|stress|panic|spiraling/.test(text)) return 'okay';
  if (/tired|exhaust|drain|sluggish|no energy|barely/.test(text)) return 'foggy';
  if (/awful|terrible|struggl|hard day|can\'t/.test(text)) return 'struggling';
  if (/great|amazing|energized|crush|pumped|ready/.test(text)) return 'energized';
  if (/good|solid|fine|alright|okay/.test(text)) return 'good';
  return 'okay';
}

// Extract any tasks mentioned in the conversation (simple keyword extraction).
// Used to build the "tasks I extracted" preview shown in the CTA.
function extractMentionedTasks(messages) {
  const userText = messages.filter(m => m.role === 'user').map(m => m.message).join(' ');
  // Split on common task delimiters and filter short fragments
  const fragments = userText
    .split(/[,;.\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 8 && s.length < 120)
    .filter(s => !/^(and|but|so|yeah|yes|no|i|the|a|an|it|this|that|they)\b/i.test(s));
  // Dedupe and cap at 5
  const seen = new Set();
  const tasks = [];
  for (const f of fragments) {
    const key = f.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      tasks.push(f.charAt(0).toUpperCase() + f.slice(1));
    }
    if (tasks.length >= 5) break;
  }
  return tasks;
}

// Fallback replies when AI is unavailable.
function getFallback(turnNumber) {
  const fallbacks = [
    "Got it. What's the one thing underneath all of that?",
    "What feels like the actual blocker — not having time, not knowing how to start, or something else?",
    "If you got one thing done today, what would make it feel worth it?",
    "I've got a sense of what matters to you. Sign up to keep going — I'll remember all of this."
  ];
  return fallbacks[Math.min(turnNumber - 1, fallbacks.length - 1)];
}

// ── Build CTA prompt based on conversation depth ──────────────────────────────
// Returns null (no CTA yet) or an object with { type, message }.
function buildCtaPrompt(messageCount, extractedTasks, isComplete) {
  if (isComplete) {
    return {
      type: 'complete',
      message: "You're on a roll — sign up to keep all of this and pick up where we left off.",
      cta: "Create your free account →"
    };
  }
  if (messageCount >= 5 && extractedTasks.length >= 2) {
    return {
      type: 'tasks_extracted',
      message: `I've got ${extractedTasks.length} things to track for you. Sign up to save them.`,
      cta: "Save my tasks →"
    };
  }
  if (messageCount === 5) {
    return {
      type: 'halfway',
      message: "This is getting real. Sign up to continue with no limits.",
      cta: "Continue in FocusLedger →"
    };
  }
  return null;
}

module.exports = function(pool) {
  const router = express.Router();

  // ─── POST /api/buddy-demo/conversation ────────────────────────────────────────
  // Anonymous conversation. Creates session if session_token not provided.
  // Returns { success, sessionToken, reply, turn, isComplete, ctaPrompt, extractedTasks }
  router.post('/conversation', demoIpLimiter, async (req, res) => {
    try {
      const { message, session_token } = req.body;

      if (!message || !message.trim()) {
        return res.status(400).json({ success: false, message: 'message required' });
      }

      // Generate token if client doesn't have one yet
      const sessionToken = session_token || crypto.randomUUID();

      const session = await getOrCreateSession(pool, sessionToken);

      // Hard rate limit check
      if (isRateLimited(session)) {
        return res.json({
          success: true,
          sessionToken,
          rateLimited: true,
          reply: "You've got a lot going on — too much to fit in a demo. Sign up and let's actually tackle it.",
          ctaPrompt: {
            type: 'rate_limited',
            message: "You've used all your demo messages. Create a free account to continue.",
            cta: "Create free account →"
          },
          extractedTasks: session.extracted_tasks || [],
          turn: session.message_count,
          isComplete: true
        });
      }

      // Load conversation history
      const history = await getTurns(pool, session.id);
      const userTurns = history.filter(h => h.role === 'user').length;
      const nextTurn = history.length + 1;
      const thisTurnNumber = userTurns + 1;

      // Save user's message
      await insertTurn(pool, session.id, 'user', message.trim(), nextTurn);

      // Build prompt and context
      const systemPrompt = buildDemoSystemPrompt(thisTurnNumber);
      const contextHistory = history.map(h => ({
        role: h.role === 'buddy' ? 'assistant' : 'user',
        content: h.message
      }));
      contextHistory.push({ role: 'user', content: message.trim() });

      // Get AI reply
      let buddyReply;
      try {
        const messages = [{ role: 'system', content: systemPrompt }].concat(contextHistory);
        buddyReply = await chatMessages(messages, { maxTokens: 250 });
      } catch (aiErr) {
        console.error('[buddy-demo] AI error:', aiErr.message);
        buddyReply = getFallback(thisTurnNumber);
      }

      // Check for completion signal
      let isComplete = false;
      if (buddyReply.includes('[[DEMO_COMPLETE]]')) {
        isComplete = true;
        buddyReply = buddyReply.replace('[[DEMO_COMPLETE]]', '').trim();
      }

      // Save Buddy's reply
      const buddyTurn = nextTurn + 1;
      await insertTurn(pool, session.id, 'buddy', buddyReply, buddyTurn);

      // Extract tasks + infer mood from accumulated conversation
      const allMessages = history.concat([
        { role: 'user', message: message.trim() },
        { role: 'buddy', message: buddyReply }
      ]);
      const extractedTasks = extractMentionedTasks(allMessages);
      const detectedMood = thisTurnNumber >= 2 ? inferMoodFromText(allMessages) : null;

      // Persist session insights
      const updatedCount = (session.message_count || 0) + 1;
      const ctaPrompt = buildCtaPrompt(updatedCount, extractedTasks, isComplete);
      await updateSessionInsights(pool, session.id, {
        extractedTasks,
        surfacedValues: session.surfaced_values || [],
        detectedMood,
        conversationSummary: isComplete
          ? allMessages.filter(m => m.role === 'user').map(m => m.message).join(' | ').slice(0, 500)
          : null,
        isComplete
      });

      res.json({
        success: true,
        sessionToken,
        reply: buddyReply,
        turn: thisTurnNumber,
        isComplete,
        rateLimited: false,
        ctaPrompt,
        extractedTasks,
        remainingMessages: MAX_MESSAGES_PER_SESSION - updatedCount
      });
    } catch (err) {
      console.error('[buddy-demo] POST /conversation error:', err.message);
      res.status(500).json({ success: false, message: 'Something went wrong' });
    }
  });

  // ─── GET /api/buddy-demo/session/:token ──────────────────────────────────────
  // Retrieve session data for Part 2 (account hydration after signup).
  // Used to pre-populate tasks and mood after the user creates an account.
  router.get('/session/:token', async (req, res) => {
    try {
      const { token } = req.params;
      if (!token || token.length < 10) {
        return res.status(400).json({ success: false, message: 'Invalid token' });
      }

      const data = await getSessionData(pool, token);
      if (!data) {
        return res.status(404).json({ success: false, message: 'Session not found' });
      }

      res.json({
        success: true,
        session: {
          token: data.session.session_token,
          messageCount: data.session.message_count,
          extractedTasks: data.session.extracted_tasks,
          surfacedValues: data.session.surfaced_values,
          detectedMood: data.session.detected_mood,
          conversationSummary: data.session.conversation_summary,
          isComplete: data.session.is_complete,
          createdAt: data.session.created_at
        },
        turns: data.turns
      });
    } catch (err) {
      console.error('[buddy-demo] GET /session error:', err.message);
      res.status(500).json({ success: false, message: 'Something went wrong' });
    }
  });

  return router;
};
