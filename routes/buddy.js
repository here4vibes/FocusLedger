// Owns: Accountabilibuddy check-in endpoints — morning check-in, daily plan generation,
//       evening recap, daily status, V2B pattern detection, mid-day check-ins,
//       coaching conversation check-in (V3), voice/brain-dump task parsing (V4),
//       dual-mode preference learning (V4), Tandem partner-context injection,
//       "I'm stuck" AI task breakdown into micro-steps (task_substeps table).
// Does NOT own: task CRUD, user auth, values management, Tandem subscription gating,
//               or partner concern storage (see routes/partnerships.js).
//
// Endpoints:
//   GET  /api/buddy/status          — today's check-in state + today's tasks
//   GET  /api/buddy/login-checkin-status — whether the post-login check-in is due today
//   POST /api/buddy/login-checkin-done   — mark the post-login check-in complete for today
//   GET  /api/buddy/session-status  — V3: session count + today's plan status (smart landing)
//   POST /api/buddy/increment-session — V3: increment session_count on each login
//   POST /api/buddy/conversation    — V3: post one conversational turn, get Buddy reply
//   POST /api/buddy/generate-insights — V3: first-session personalized insight + starter tasks
//   GET  /api/buddy/daily-plan      — get (or generate) today's AI daily plan
//   POST /api/buddy/daily-plan/accept    — accept the plan
//   POST /api/buddy/daily-plan/swap      — swap one task slot with a replacement
//   POST /api/buddy/daily-plan/regenerate — regenerate the plan (new scoring run)
//   POST /api/buddy/morning         — (legacy compat) store morning focus selection
//   POST /api/buddy/break-down      — "I'm stuck": AI breaks task into < 1-min micro-steps
//   GET  /api/buddy/substeps/:taskId — fetch saved substeps for a task
//   POST /api/buddy/substeps/:substepId/toggle — mark a substep complete/incomplete
//   POST /api/buddy/evening         — store evening recap view
//   GET  /api/buddy/patterns        — V2B: run pattern detection, return dashboard data
//   GET  /api/buddy/midday-checkin  — V2B: determine if a mid-day check-in is due
//   POST /api/buddy/midday-checkin  — V2B: store user's mid-day check-in response
//   GET  /api/buddy/mode-preference — V4: get current mode preference + which mode to show
//   POST /api/buddy/mode-preference — V4: record session outcome, update learned preference
//   POST /api/buddy/brain-dump-tasks — V4: parse conversation into candidate tasks (NLP+AI)
//   POST /api/buddy/confirm-tasks    — V4: user confirmed tasks → insert into tasks table

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { chatMessages } = require('../lib/polsia-ai');
const { extractTasks, detectCompletions, extractPassiveCapture, isBrainDump, extractBrainDump } = require('../lib/taskParsingService');
const {
  runPatternDetection,
  getMidDayCheckinType,
  buildGreetingContext
} = require('../lib/buddyPatterns');
const {
  getActivePartnership,
  checkTandemAccess,
  getActiveConcernsAboutUser,
} = require('../db/partnerships');
const { fetchUserTimezone, getUserLocalDate, getUserLocalHour } = require('../lib/timezone');
const { saveSubsteps, getSubsteps, toggleSubstep, checkAllDone } = require('../db/substeps');
const { actionableDateFilter } = require('../lib/task-filters');
const {
  checkAndGenerateNudges,
  getSessionNudges,
  getLocalTimeString,
} = require('../lib/routineNudgeEngine');
const { getSessionSuggestion } = require('../lib/patternDetection');

// ── Scoring weights ─────────────────────────────────────────────────────────
// Deadline urgency (40%), values alignment (25%), avoidance detection (20%),
// energy match (15%). All weights sum to 1.0.
const WEIGHTS = {
  deadline: 0.40,
  values:   0.25,
  avoidance: 0.20,
  energy:   0.15
};

// Energy-level mapping: which task priorities are preferred per mood.
// Low-energy moods prefer low-activation tasks (short, simple).
// High-energy moods prefer tasks with more substance.
const ENERGY_PROFILE = {
  energized:  { preferred: ['high', 'medium'],  avoid: [] },
  good:       { preferred: ['high', 'medium'],  avoid: [] },
  okay:       { preferred: ['medium', 'low'],   avoid: [] },
  foggy:      { preferred: ['low', 'medium'],   avoid: ['high'] },
  struggling: { preferred: ['low'],             avoid: ['high', 'medium'] }
};

// Days a task must exist without completion before it gets avoidance boost
const AVOIDANCE_THRESHOLD_DAYS = 5;

// ── Score a batch of tasks ───────────────────────────────────────────────────
// Returns tasks sorted descending by composite score, with reason strings.
function scoreTasks(tasks, mood, todayStr, userValues) {
  const today = new Date(todayStr + 'T12:00:00Z');
  const energyProfile = ENERGY_PROFILE[mood] || ENERGY_PROFILE.okay;
  const valueIds = new Set((userValues || []).map(v => v.id));

  const scored = tasks.map(task => {
    // ── Deadline urgency score (0.0–1.0) ────────────────────────────────
    let deadlineScore = 0;
    let deadlineReason = null;
    if (task.due_date) {
      const due = new Date(task.due_date + 'T12:00:00Z');
      const daysUntil = Math.round((due - today) / (1000 * 60 * 60 * 24));
      if (daysUntil < 0) {
        deadlineScore = 1.0;
        deadlineReason = `Overdue ${Math.abs(daysUntil)} day${Math.abs(daysUntil) !== 1 ? 's' : ''}`;
      } else if (daysUntil === 0) {
        deadlineScore = 0.9;
        deadlineReason = 'Due today';
      } else if (daysUntil <= 2) {
        deadlineScore = 0.75;
        deadlineReason = `Due in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;
      } else if (daysUntil <= 7) {
        deadlineScore = 0.5;
        deadlineReason = `Due this week`;
      } else {
        deadlineScore = Math.max(0, 0.3 - (daysUntil - 7) * 0.02);
      }
    } else {
      // No due date — mild urgency based on how long it's been on the list
      const ageMs = today - new Date(task.created_at);
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      deadlineScore = Math.min(0.2, ageDays / 60);
    }

    // ── Values alignment score (0.0–1.0) ────────────────────────────────
    let valuesScore = 0;
    let valuesReason = null;
    if (task.value_id && valueIds.has(task.value_id)) {
      const val = (userValues || []).find(v => v.id === task.value_id);
      valuesScore = 1.0;
      if (val) valuesReason = `Aligns with ${val.value_name}`;
    } else if (task.value_id) {
      // Has a value tag but it's not in top values — partial credit
      valuesScore = 0.3;
    }

    // ── Avoidance detection score (0.0–1.0) ─────────────────────────────
    // Due-date-aware: tasks with a due date > 7 days out get no avoidance boost
    // (rational prioritization, not avoidance). Tasks approaching or overdue
    // get a boosted signal. No-due-date tasks use the original 5-day rule.
    let avoidanceScore = 0;
    let avoidanceReason = null;
    const ageMs = today - new Date(task.created_at);
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (task.due_date) {
      const due = new Date(task.due_date + 'T12:00:00Z');
      const daysUntil = Math.round((due - today) / (1000 * 60 * 60 * 24));
      if (daysUntil < 0) {
        // Overdue — max avoidance signal
        avoidanceScore = 1.0;
        avoidanceReason = `Overdue — needs attention now`;
      } else if (daysUntil <= 3) {
        // Due within 3 days — strong avoidance signal
        avoidanceScore = 0.9;
        avoidanceReason = daysUntil === 0 ? `Due today — don't let it slip` : `Due in ${daysUntil} day${daysUntil !== 1 ? 's' : ''} — time to start`;
      } else if (daysUntil <= 7 && ageDays >= 3) {
        // Approaching (3-7 days out, sitting 3+ days) — moderate signal
        avoidanceScore = 0.5;
        avoidanceReason = `Due in ${daysUntil} days — a good time to start`;
      }
      // daysUntil > 7: avoidanceScore stays 0 — not flagged as avoidance
    } else {
      // No due date — original 5-day rule
      if (ageDays >= AVOIDANCE_THRESHOLD_DAYS) {
        // Scales up: 5 days = 0.3, 10 days = 0.7, 14+ days = 1.0
        avoidanceScore = Math.min(1.0, (ageDays - AVOIDANCE_THRESHOLD_DAYS) / 9);
        if (ageDays >= 14) {
          avoidanceReason = `On your list ${Math.round(ageDays)} days — time to tackle it`;
        } else {
          avoidanceReason = `${Math.round(ageDays)} days on your list`;
        }
      }
    }

    // ── Energy match score (0.0–1.0) ────────────────────────────────────
    let energyScore = 0.5; // neutral default
    let energyReason = null;
    const priority = (task.priority || 'medium').toLowerCase();
    if (energyProfile.avoid.includes(priority)) {
      energyScore = 0.0;
      if (mood === 'foggy' || mood === 'struggling') {
        energyReason = 'Quick win for a low-energy day';
      }
    } else if (energyProfile.preferred.includes(priority)) {
      energyScore = 1.0;
      if (priority === 'low' && (mood === 'foggy' || mood === 'struggling')) {
        energyReason = 'Low-activation task — good for today';
      }
    }

    // ── Composite score ─────────────────────────────────────────────────
    const composite =
      WEIGHTS.deadline  * deadlineScore +
      WEIGHTS.values    * valuesScore   +
      WEIGHTS.avoidance * avoidanceScore +
      WEIGHTS.energy    * energyScore;

    // ── Reason selection: pick the most prominent signal ────────────────
    // Priority: deadline (if overdue/urgent) > avoidance (if 14+ days) > values > avoidance > energy
    let reason = null;
    if (deadlineScore >= 0.9 && deadlineReason) {
      reason = deadlineReason;
    } else if (avoidanceScore >= 0.8 && avoidanceReason) {
      reason = avoidanceReason;
    } else if (valuesReason) {
      reason = valuesReason;
    } else if (avoidanceReason) {
      reason = avoidanceReason;
    } else if (energyReason) {
      reason = energyReason;
    } else if (deadlineReason) {
      reason = deadlineReason;
    } else {
      reason = 'Ready to do';
    }

    // ── Activation energy label ─────────────────────────────────────────
    let activation = 'Medium';
    if (priority === 'low') activation = 'Low';
    else if (priority === 'high') activation = 'High';

    return {
      task,
      composite,
      reason,
      activation
    };
  });

  // Sort descending by composite score
  scored.sort((a, b) => b.composite - a.composite);
  return scored;
}

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─── GET /api/buddy/session-status ──────────────────────────────────────────
  // V3: returns session count, whether check-in is due, and today's plan state.
  // Used by the new landing logic to decide: full check-in vs status view.
  router.get('/session-status', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      const userResult = await pool.query(
        `SELECT login_checkin_done_date, login_last_mood, session_count,
                previous_checkin_summary, first_session_insights_done
         FROM users WHERE id = $1`,
        [userId]
      );
      const user = userResult.rows[0];
      const lastDone = user && user.login_checkin_done_date;
      const dueToday = !lastDone || String(lastDone).slice(0, 10) !== today;
      const sessionCount = (user && user.session_count) || 0;

      // Cross-domain greeting insights (days 3-8 progressive intelligence).
      // Best-effort — never blocks the response if it fails.
      let greetingInsights = [];
      try {
        greetingInsights = await buildGreetingContext(pool, userId, sessionCount, tz);
      } catch (_) { /* non-blocking */ }

      // Routine nudges — generate any missed-routine events, then fetch pending.
      // Best-effort — Buddy session works fine even if this fails.
      let routineNudges = [];
      try {
        const localDate = getUserLocalDate(tz);
        const localTime = getLocalTimeString(tz);
        await checkAndGenerateNudges(pool, userId, localDate, tz);
        routineNudges = await getSessionNudges(pool, userId, localDate, localTime);
      } catch (_) { /* non-blocking */ }

      // Auto-routines suggestion — passive pattern detection surfaced at session start.
      // Max 1 suggestion per session; ephemeral (expires after 3 ignored sessions).
      // Best-effort — Buddy works fine even if this fails.
      let autoRoutineSuggestion = null;
      try {
        autoRoutineSuggestion = await getSessionSuggestion(pool, userId);
      } catch (_) { /* non-blocking */ }

      let planSummary = null;
      if (!dueToday) {
        const planResult = await pool.query(
          `SELECT task_1_id, task_2_id, task_3_id, accepted,
                  task_1_reason, task_2_reason, task_3_reason
           FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2`,
          [userId, today]
        );
        if (planResult.rows.length > 0) {
          const plan = planResult.rows[0];
          const taskIds = [plan.task_1_id, plan.task_2_id, plan.task_3_id].filter(Boolean);
          let tasks = [];
          if (taskIds.length > 0) {
            const taskResult = await pool.query(
              `SELECT id, title, is_completed FROM tasks WHERE id = ANY($1)`,
              [taskIds]
            );
            tasks = taskResult.rows;
          }
          const completedCount = tasks.filter(function(t) { return t.is_completed; }).length;
          planSummary = {
            task1: tasks.find(function(t) { return t.id === plan.task_1_id; }) || null,
            task2: tasks.find(function(t) { return t.id === plan.task_2_id; }) || null,
            task3: tasks.find(function(t) { return t.id === plan.task_3_id; }) || null,
            completedCount,
            totalCount: taskIds.length,
            allDone: completedCount === taskIds.length && taskIds.length > 0
          };
        }
      }

      res.json({
        success: true,
        dueToday,
        sessionCount,
        mood: (user && user.login_last_mood) || null,
        previousCheckinSummary: (user && user.previous_checkin_summary) || null,
        firstSessionInsightsDone: (user && user.first_session_insights_done) || false,
        planSummary,
        greetingInsights,
        routineNudges,
        autoRoutineSuggestion
      });
    } catch (err) {
      console.error('[buddy] GET /session-status error:', err.message);
      res.json({ success: true, dueToday: true, sessionCount: 0, planSummary: null });
    }
  });

  // ─── POST /api/buddy/increment-session ───────────────────────────────────────
  // V3: called once per login to increment session_count.
  router.post('/increment-session', async (req, res) => {
    try {
      await pool.query(
        `UPDATE users SET session_count = session_count + 1 WHERE id = $1`,
        [req.user.id]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[buddy] POST /increment-session error:', err.message);
      res.json({ success: true });
    }
  });

  // ─── POST /api/buddy/conversation ────────────────────────────────────────────
  // V5: post one user message in the coaching conversation.
  // Returns Buddy's reply + whether the conversation is complete.
  // Also runs passive completion detection — if the user mentions finishing a task,
  // it's auto-marked complete and returned in `autoCompleted`.
  // Body: { message: string, date?: string, greetingContext?: Array }
  router.post('/conversation', async (req, res) => {
    try {
      const userId = req.user.id;
      const { message, date, greetingContext } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      if (!message || !message.trim()) {
        return res.status(400).json({ success: false, message: 'message required' });
      }

      // Load existing conversation turns + active tasks (for completion detection) in parallel.
      // Also fetch partner context for Tandem users — best-effort, never blocks the response.
      const [histResult, activeTasksResult, partnerCtx] = await Promise.all([
        pool.query(
          `SELECT role, message FROM buddy_conversations
           WHERE user_id = $1 AND session_date = $2
           ORDER BY turn ASC`,
          [userId, today]
        ),
        pool.query(
          `SELECT id, title FROM tasks WHERE user_id = $1 AND is_completed = false AND ${actionableDateFilter(2)} ORDER BY created_at DESC LIMIT 50`,
          [userId, today]
        ),
        // Only fetch partner context on first turn to avoid repeated DB queries per turn
        buildPartnerContext(pool, userId, today).catch(() => null),
      ]);
      const history = histResult.rows;
      const activeTasks = activeTasksResult.rows;
      const nextTurn = history.length + 1;

      // Save user's message
      await pool.query(
        `INSERT INTO buddy_conversations (user_id, session_date, turn, role, message)
         VALUES ($1, $2, $3, 'user', $4)`,
        [userId, today, nextTurn, message.trim()]
      );

      const userTurns = history.filter(function(h) { return h.role === 'user'; }).length + 1;

      // Fetch session count + hook restart count for progressive hook gating.
      // hookRestartCount > 0 triggers restart-aware copy variants in the prompt.
      const sessionResult = await pool.query(
        `SELECT session_count, COALESCE(buddy_hook_restart_count, 0) AS buddy_hook_restart_count FROM users WHERE id = $1`,
        [userId]
      );
      const sessionCount      = (sessionResult.rows[0] && sessionResult.rows[0].session_count) || 0;
      const hookRestartCount  = (sessionResult.rows[0] && sessionResult.rows[0].buddy_hook_restart_count) || 0;

      // ── Brain dump fast path ─────────────────────────────────────────────
      // Detect before the normal AI reply to avoid double-spending AI tokens.
      if (isBrainDump(message.trim(), userTurns)) {
        const userValues = activeTasks.length
          ? [] // values fetched separately below if needed
          : [];
        const { tasks: dumpTasks, summary: dumpSummary } = await extractBrainDump(message.trim(), userValues);

        // Auto-create actionable tasks (do_today + do_soon); park the rest
        const created = [];
        for (const t of dumpTasks) {
          try {
            const priority = t.category === 'do_today' ? 'high' : t.category === 'do_soon' ? 'medium' : 'low';
            const ins = await pool.query(
              `INSERT INTO tasks (user_id, title, priority, value_id, is_completed, created_at)
               VALUES ($1, $2, $3, $4, false, NOW()) RETURNING id, title`,
              [userId, (t.title || '').slice(0, 200), priority, t.value_id || null]
            );
            if (ins.rows[0]) created.push({ ...ins.rows[0], category: t.category });
          } catch (_) { /* skip individual task errors */ }
        }

        const doToday  = created.filter(t => t.category === 'do_today');
        const doSoon   = created.filter(t => t.category === 'do_soon');
        const parked   = created.filter(t => t.category === 'parked');

        let buddyReply = dumpSummary + '\n\n';
        if (doToday.length)  buddyReply += `✅ **Do Today (${doToday.length}):** ${doToday.map(t => t.title).join(', ')}\n`;
        if (doSoon.length)   buddyReply += `📋 **Do Soon (${doSoon.length}):** ${doSoon.map(t => t.title).join(', ')}\n`;
        if (parked.length)   buddyReply += `🗂 **Parked (${parked.length}):** ${parked.map(t => t.title).join(', ')}\n`;
        buddyReply += '\nAll added to your task list. Want to start on anything from the Do Today pile?';

        const buddyTurn = nextTurn + 1;
        await pool.query(
          `INSERT INTO buddy_conversations (user_id, session_date, turn, role, message)
           VALUES ($1, $2, $3, 'buddy', $4)`,
          [userId, today, buddyTurn, buddyReply]
        );

        return res.json({
          success: true,
          reply: buddyReply,
          turn: userTurns,
          isComplete: false,
          detectedMood: null,
          autoCompleted: [],
          capturedTasks: [],
          capturedExpenses: [],
          isBrainDump: true,
          brainDumpTasks: created,
        });
      }
      // ── End brain dump fast path ─────────────────────────────────────────

      // Passive completion detection — run in parallel with AI reply generation
      // greetingContext passed from client (populated from /session-status response)
      const contextForPrompt = Array.isArray(greetingContext) ? greetingContext : [];

      // If client didn't forward greetingInsights AND we're in the progressive hook window
      // (sessions 3-8), fetch them server-side so the AI has cross-domain context.
      let enrichedContext = contextForPrompt;
      if (contextForPrompt.length === 0 && sessionCount >= 3 && sessionCount <= 8 && userTurns <= 1) {
        try {
          enrichedContext = await buildGreetingContext(pool, userId, sessionCount, tz);
        } catch (_) { /* non-blocking */ }
      }

      // Partner context injected only on first 2 turns — Buddy uses it to set coaching tone,
      // not to repeatedly surface partner info throughout the conversation.
      const partnerContextForPrompt = userTurns <= 2 ? partnerCtx : null;
      const systemPrompt = buildConversationSystemPrompt(userTurns, enrichedContext, partnerContextForPrompt, sessionCount, hookRestartCount);
      const contextHistory = history.map(function(h) {
        return { role: h.role === 'buddy' ? 'assistant' : 'user', content: h.message };
      });
      contextHistory.push({ role: 'user', content: message.trim() });

      // Run AI reply + completion detection + passive capture in parallel
      const [aiResult, completionMatches, passiveCapture] = await Promise.all([
        (async () => {
          try {
            const messages = [{ role: 'system', content: systemPrompt }].concat(contextHistory);
            const reply = await chatMessages(messages, { maxTokens: 300 });
            return { reply, error: false };
          } catch (aiErr) {
            console.error('[buddy] conversation AI error:', aiErr.message);
            return { reply: getFallbackBuddyReply(userTurns), error: true };
          }
        })(),
        detectCompletions(message.trim(), activeTasks),
        extractPassiveCapture(message.trim()).catch(() => ({ tasks: [], expenses: [] })),
      ]);

      let buddyReply = aiResult.reply;
      let isComplete = false;
      let detectedMood = null;

      if (buddyReply.includes('[[CONVERSATION_COMPLETE]]')) {
        isComplete = true;
        buddyReply = buddyReply.replace('[[CONVERSATION_COMPLETE]]', '').trim();
      }
      if (aiResult.error && userTurns >= 4) isComplete = true;

      if (userTurns >= 2) {
        detectedMood = inferMoodFromText(history.concat([{ role: 'user', message: message.trim() }]));
      }

      const buddyTurn = nextTurn + 1;
      await pool.query(
        `INSERT INTO buddy_conversations (user_id, session_date, turn, role, message)
         VALUES ($1, $2, $3, 'buddy', $4)`,
        [userId, today, buddyTurn, buddyReply]
      );

      // Apply completions detected in the user's message
      const autoCompleted = [];
      for (const match of completionMatches) {
        if (match.match_type === 'complete') {
          try {
            const result = await pool.query(
              `UPDATE tasks SET is_completed = true, completed_at = NOW()
               WHERE id = $1 AND user_id = $2 AND is_completed = false
               RETURNING id, title`,
              [match.task_id, userId]
            );
            if (result.rows.length > 0) {
              autoCompleted.push({
                task_id: match.task_id,
                title: result.rows[0].title,
                matched_phrase: match.matched_phrase || null
              });
            }
          } catch (completionErr) {
            console.error('[buddy] conversation auto-completion error:', completionErr.message);
          }
        }
      }

      if (isComplete) {
        const allUserMsgs = history
          .filter(function(h) { return h.role === 'user'; })
          .map(function(h) { return h.message; });
        allUserMsgs.push(message.trim());
        const summary = allUserMsgs.join(' | ').slice(0, 500);
        await pool.query(
          `UPDATE users SET previous_checkin_summary = $1 WHERE id = $2`,
          [summary, userId]
        );
        if (detectedMood) {
          await pool.query(
            `UPDATE users SET login_last_mood = $1 WHERE id = $2`,
            [detectedMood, userId]
          );
        }

        // Archive conversation to Journal as a readable entry.
        // Non-blocking — journal archiving never fails the check-in response.
        archiveBuddyConversationToJournal(pool, userId, today, allUserMsgs, detectedMood, buddyReply).catch(archErr => {
          console.error('[buddy] journal archive error:', archErr.message);
        });
      }

      // Filter captured tasks: skip titles that closely match what was just auto-completed
      const completedTitles = new Set(autoCompleted.map(t => t.title.toLowerCase()));
      const capturedTasks = (passiveCapture.tasks || []).filter(
        t => !completedTitles.has((t.title || '').toLowerCase())
      );
      const capturedExpenses = passiveCapture.expenses || [];

      res.json({ success: true, reply: buddyReply, turn: userTurns, isComplete, detectedMood, autoCompleted, capturedTasks, capturedExpenses });
    } catch (err) {
      console.error('[buddy] POST /conversation error:', err.message);
      res.status(500).json({ success: false, message: 'Conversation error' });
    }
  });

  // ─── POST /api/buddy/generate-insights ───────────────────────────────────────
  // V3: first-session personalized insight + generate 3-5 starter tasks.
  // Called after first-ever check-in completes (session_count === 1).
  router.post('/generate-insights', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = req.body.date || getUserLocalDate(tz);

      const convResult = await pool.query(
        `SELECT role, message FROM buddy_conversations
         WHERE user_id = $1 AND session_date = $2
         ORDER BY turn ASC`,
        [userId, today]
      );
      const userMessages = convResult.rows
        .filter(function(r) { return r.role === 'user'; })
        .map(function(r) { return r.message; });

      if (!userMessages.length) {
        return res.json({ success: true, insight: null, tasksCreated: 0 });
      }

      const valuesResult = await pool.query(
        `SELECT value_name FROM user_values WHERE user_id = $1 ORDER BY rank ASC LIMIT 5`,
        [userId]
      );
      const values = valuesResult.rows.map(function(v) { return v.value_name; });

      let insight = null;
      let starterTaskTitles = [];

      try {
        const prompt = buildInsightsPrompt(userMessages, values);
        const raw = await chatMessages([{ role: 'user', content: prompt }], {
          maxTokens: 600,
          system: 'You are Buddy, an ADHD coaching assistant. Return only valid JSON. No markdown.'
        });
        const parsed = JSON.parse(raw.trim().replace(/^```json\s*/,'').replace(/\s*```$/,''));
        insight = parsed.insight || null;
        starterTaskTitles = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 5) : [];
      } catch (aiErr) {
        console.error('[buddy] generate-insights AI error:', aiErr.message);
      }

      let tasksCreated = 0;
      for (let i = 0; i < starterTaskTitles.length; i++) {
        const title = starterTaskTitles[i];
        if (!title || !title.trim()) continue;
        try {
          await pool.query(
            `INSERT INTO tasks (user_id, title, is_completed, priority, created_at)
             VALUES ($1, $2, false, 'medium', NOW())`,
            [userId, title.trim().slice(0, 200)]
          );
          tasksCreated++;
        } catch (taskErr) {
          console.error('[buddy] starter task insert error:', taskErr.message);
        }
      }

      await pool.query(
        `UPDATE users SET first_session_insights_done = true WHERE id = $1`,
        [userId]
      );

      res.json({ success: true, insight, tasksCreated });
    } catch (err) {
      console.error('[buddy] POST /generate-insights error:', err.message);
      res.status(500).json({ success: false, message: 'Insights generation failed' });
    }
  });

  // ─── GET /api/buddy/login-checkin-status ────────────────────────────────
  // Returns whether the post-login check-in is still due today.
  // dueToday: true  → show the check-in flow
  // dueToday: false → already done today, skip to home
  router.get('/login-checkin-status', async (req, res) => {
    try {
      const tz = await fetchUserTimezone(pool, req.user.id);
      const today = getUserLocalDate(tz);
      const result = await pool.query(
        'SELECT login_checkin_done_date FROM users WHERE id = $1',
        [req.user.id]
      );
      const lastDone = result.rows[0]?.login_checkin_done_date;
      // pg returns DATE as "YYYY-MM-DD" string (type parser override in server.js)
      const dueToday = !lastDone || String(lastDone).slice(0, 10) !== today;
      res.json({ success: true, dueToday });
    } catch (err) {
      console.error('[buddy] GET /login-checkin-status error:', err.message);
      // Fail open — don't block the user from getting into the app
      res.json({ success: true, dueToday: false });
    }
  });

  // ─── POST /api/buddy/login-checkin-done ─────────────────────────────────
  // Marks today's post-login check-in as complete.
  // Body: { mood?: string, intention?: string }
  // mood is stored in users.login_last_mood for Accountabilibuddy correlation.
  router.post('/login-checkin-done', async (req, res) => {
    try {
      const userId = req.user.id;
      const { mood, intention } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      await pool.query(
        `UPDATE users
         SET login_checkin_done_date = $1
           , login_last_mood = COALESCE($2, login_last_mood)
         WHERE id = $3`,
        [today, mood || null, userId]
      );

      // Store intention in buddy check-in if provided
      if (intention && intention.trim()) {
        await pool.query(`
          INSERT INTO buddy_checkins (user_id, checkin_date, checkin_type, selected_task_id)
          VALUES ($1, $2, 'morning_intention', NULL)
          ON CONFLICT (user_id, checkin_date, checkin_type)
          DO UPDATE SET tasks_completed = buddy_checkins.tasks_completed
        `, [userId, today]);
        // Store intention text in a lightweight way — extend tasks notes column isn't available
        // so we use the existing buddy_midday_checkins response JSONB field
        await pool.query(`
          INSERT INTO buddy_midday_checkins (user_id, checkin_type, plan_id, response, checkin_date)
          VALUES ($1, 'morning_intention', NULL, $2, $3)
          ON CONFLICT DO NOTHING
        `, [userId, JSON.stringify({ intention: intention.trim() }), today]);
      }

      res.json({ success: true });
    } catch (err) {
      console.error('[buddy] POST /login-checkin-done error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save check-in' });
    }
  });

  // ─── GET /api/buddy/status ───────────────────────────────────────────────
  // Returns today's check-in records + today's tasks.
  router.get('/status', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = req.query.date || getUserLocalDate(tz);

      // Fetch tasks relevant to the morning check-in: overdue, due today/within 3 days, or no due date.
      // Tasks due 4+ days out are excluded — not actionable now, and showing them adds cognitive load.
      // Uses shared actionableDateFilter — DO NOT inline a separate copy of this filter.
      const tasksResult = await pool.query(`
        SELECT id, title, is_completed, due_date, completed_at, created_at, priority, value_id
        FROM tasks
        WHERE user_id = $1
          AND is_completed = false
          AND ${actionableDateFilter(2)}
        ORDER BY due_date ASC NULLS LAST, created_at ASC
        LIMIT 50
      `, [userId, today]);

      // Count tasks completed today (for evening recap)
      const completedResult = await pool.query(`
        SELECT COUNT(*) as count
        FROM tasks
        WHERE user_id = $1
          AND is_completed = true
          AND completed_at::date = $2::date
      `, [userId, today]);

      // Fetch both check-ins for today
      const checkinsResult = await pool.query(`
        SELECT id, checkin_type, checkin_date, selected_task_id,
               tasks_completed, tasks_open, created_at
        FROM buddy_checkins
        WHERE user_id = $1 AND checkin_date = $2
      `, [userId, today]);

      const morning = checkinsResult.rows.find(r => r.checkin_type === 'morning') || null;
      const evening = checkinsResult.rows.find(r => r.checkin_type === 'evening') || null;

      // Fetch today's daily plan if it exists
      const planResult = await pool.query(
        'SELECT * FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2',
        [userId, today]
      );
      const dailyPlan = planResult.rows[0] || null;

      // Enrich plan with task titles so the frontend has them immediately
      // (avoids a secondary fetch and the blank-title bug for accepted plans)
      let dailyPlanSlots = null;
      if (dailyPlan) {
        const enriched = await enrichPlan(dailyPlan, pool);
        dailyPlanSlots = enriched.slots;
      }

      res.json({
        success: true,
        date: today,
        tasks: tasksResult.rows,
        tasksCompletedToday: parseInt(completedResult.rows[0].count, 10),
        morning,
        evening,
        dailyPlan,
        dailyPlanSlots
      });
    } catch (err) {
      console.error('[buddy] GET /status error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to load buddy status' });
    }
  });

  // ─── GET /api/buddy/daily-plan ───────────────────────────────────────────
  // Returns today's plan (existing or newly generated).
  // Accepts ?mood= to influence scoring on first generation.
  router.get('/daily-plan', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = req.query.date || getUserLocalDate(tz);
      const mood = req.query.mood || null;

      // Check for existing plan
      const existing = await pool.query(
        'SELECT * FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2',
        [userId, today]
      );

      if (existing.rows.length > 0) {
        // Enrich with task details
        const plan = existing.rows[0];
        return res.json({ success: true, plan, generated: false, ...(await enrichPlan(plan, pool)) });
      }

      // Generate a new plan
      const generated = await generatePlan(userId, today, mood, pool);
      res.json({ success: true, plan: generated.plan, generated: true, slots: generated.slots });
    } catch (err) {
      console.error('[buddy] GET /daily-plan error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to generate daily plan' });
    }
  });

  // ─── POST /api/buddy/daily-plan/accept ──────────────────────────────────
  // Accept the plan — marks it as accepted in DB.
  router.post('/daily-plan/accept', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = req.body.date || getUserLocalDate(tz);

      const result = await pool.query(
        `UPDATE buddy_daily_plans
         SET accepted = true
         WHERE user_id = $1 AND plan_date = $2
         RETURNING *`,
        [userId, today]
      );

      if (!result.rows.length) {
        return res.status(404).json({ success: false, message: 'No plan for today' });
      }

      res.json({ success: true, plan: result.rows[0] });
    } catch (err) {
      console.error('[buddy] POST /daily-plan/accept error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to accept plan' });
    }
  });

  // ─── POST /api/buddy/daily-plan/swap ────────────────────────────────────
  // Swap one task slot (1/2/3) with a user-selected replacement task.
  router.post('/daily-plan/swap', async (req, res) => {
    try {
      const userId = req.user.id;
      const { slot, new_task_id, reason, date } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      if (![1, 2, 3].includes(parseInt(slot, 10))) {
        return res.status(400).json({ success: false, message: 'Invalid slot (1, 2, or 3)' });
      }

      // Validate task belongs to user
      const taskCheck = await pool.query(
        'SELECT id, title FROM tasks WHERE id = $1 AND user_id = $2 AND is_completed = false',
        [new_task_id, userId]
      );
      if (!taskCheck.rows.length) {
        return res.status(400).json({ success: false, message: 'Task not found' });
      }

      const slotNum = parseInt(slot, 10);
      const updateResult = await pool.query(
        `UPDATE buddy_daily_plans
         SET task_${slotNum}_id = $1, task_${slotNum}_reason = $2
         WHERE user_id = $3 AND plan_date = $4
         RETURNING *`,
        [new_task_id, reason || 'Your pick', userId, today]
      );

      if (!updateResult.rows.length) {
        return res.status(404).json({ success: false, message: 'No plan for today' });
      }

      res.json({ success: true, plan: updateResult.rows[0], swappedTask: taskCheck.rows[0] });
    } catch (err) {
      console.error('[buddy] POST /daily-plan/swap error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to swap task' });
    }
  });

  // ─── POST /api/buddy/daily-plan/regenerate ───────────────────────────────
  // Delete today's plan and generate a fresh one.
  router.post('/daily-plan/regenerate', async (req, res) => {
    try {
      const userId = req.user.id;
      const { mood, date } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      // Delete existing plan for today
      await pool.query(
        'DELETE FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2',
        [userId, today]
      );

      // Generate fresh
      const generated = await generatePlan(userId, today, mood, pool);
      res.json({ success: true, plan: generated.plan, generated: true, slots: generated.slots });
    } catch (err) {
      console.error('[buddy] POST /daily-plan/regenerate error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to regenerate plan' });
    }
  });

  // ─── POST /api/buddy/morning ─────────────────────────────────────────────
  // Legacy: store morning focus selection. One per day — subsequent calls no-op.
  router.post('/morning', async (req, res) => {
    try {
      const userId = req.user.id;
      const { selected_task_id, date } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      if (selected_task_id) {
        const check = await pool.query(
          'SELECT id FROM tasks WHERE id = $1 AND user_id = $2',
          [selected_task_id, userId]
        );
        if (!check.rows.length) {
          return res.status(400).json({ success: false, message: 'Task not found' });
        }
      }

      const result = await pool.query(`
        INSERT INTO buddy_checkins (user_id, checkin_date, checkin_type, selected_task_id)
        VALUES ($1, $2, 'morning', $3)
        ON CONFLICT (user_id, checkin_date, checkin_type) DO NOTHING
        RETURNING *
      `, [userId, today, selected_task_id || null]);

      if (!result.rows.length) {
        const existing = await pool.query(
          'SELECT * FROM buddy_checkins WHERE user_id = $1 AND checkin_date = $2 AND checkin_type = $3',
          [userId, today, 'morning']
        );
        return res.json({ success: true, checkin: existing.rows[0], alreadyDone: true });
      }

      res.json({ success: true, checkin: result.rows[0], alreadyDone: false });
    } catch (err) {
      console.error('[buddy] POST /morning error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save morning check-in' });
    }
  });

  // ─── GET /api/buddy/evening-data ────────────────────────────────────────
  // P2: Pre-computed stats for the full evening wrap-up page.
  // Returns tasks completed, routines kept, docs handled, money tasks done.
  router.get('/evening-data', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      // Tasks completed today
      const tasksResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks
        WHERE user_id = $1 AND is_completed = true AND completed_at::date = $2::date
      `, [userId, today]);

      // Routines kept today — routines that have a streak event for today
      // We count routine_task_links where the linked task was completed today
      // AND the routine has an active nudge event for today
      const routinesResult = await pool.query(`
        SELECT COUNT(DISTINCT r.id) as count
        FROM routines r
        JOIN routine_nudge_events rne ON rne.routine_id = r.id AND rne.nudge_date = $2
        JOIN routine_task_links rtl ON rtl.routine_id = r.id
        JOIN tasks t ON t.id = rtl.task_id AND t.is_completed = true AND t.completed_at::date = $2::date
        WHERE r.user_id = $1 AND r.is_active = true
      `, [userId, today]);

      // Also count routines that were explicitly completed via routine_streaks today
      const explicitRoutinesResult = await pool.query(`
        SELECT COUNT(*) as count FROM routine_streaks
        WHERE user_id = $1 AND last_completed_date = $2
      `, [userId, today]);

      const routinesKept = Math.max(
        parseInt(routinesResult.rows[0].count, 10),
        parseInt(explicitRoutinesResult.rows[0].count, 10)
      );

      // Documents handled — documents with updated_at today
      const docsResult = await pool.query(`
        SELECT COUNT(*) as count FROM documents
        WHERE user_id = $1 AND updated_at::date = $2::date
      `, [userId, today]);

      // Money tasks done — tasks with a money-related categorytag or title keyword
      const moneyTasksResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks
        WHERE user_id = $1
          AND is_completed = true
          AND completed_at::date = $2::date
          AND (
            categorytag ILIKE '%money%' OR
            categorytag ILIKE '%budget%' OR
            categorytag ILIKE '%spending%' OR
            categorytag ILIKE '%expense%' OR
            categorytag ILIKE '%bill%' OR
            title ILIKE '%budget%' OR
            title ILIKE '%bill%' OR
            title ILIKE '%money%' OR
            title ILIKE '%expense%'
          )
      `, [userId, today]);

      // Total open tasks
      const openResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false
      `, [userId]);

      res.json({
        success: true,
        tasksCompletedToday: parseInt(tasksResult.rows[0].count, 10),
        tasksOpen: parseInt(openResult.rows[0].count, 10),
        routinesKeptToday: routinesKept,
        documentsHandled: parseInt(docsResult.rows[0].count, 10),
        moneyTasksDone: parseInt(moneyTasksResult.rows[0].count, 10)
      });
    } catch (err) {
      console.error('[buddy] GET /evening-data error:', err.message);
      res.json({ success: true, tasksCompletedToday: 0, tasksOpen: 0, routinesKeptToday: 0, documentsHandled: 0, moneyTasksDone: 0 });
    }
  });

  // ─── POST /api/buddy/evening ─────────────────────────────────────────────
  // P2: Store full evening wrap-up — extends beyond just money tasks.
  // Body: { date?, energy_level?, blocks_text?, tasks_completed_today?,
  //         routines_kept_today?, documents_handled?, money_tasks_done? }
  router.post('/evening', async (req, res) => {
    try {
      const userId = req.user.id;
      const { date, energy_level, blocks_text,
              tasks_completed_today, routines_kept_today,
              documents_handled, money_tasks_done } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      const completedResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks
        WHERE user_id = $1 AND is_completed = true AND completed_at::date = $2::date
      `, [userId, today]);

      const openResult = await pool.query(`
        SELECT COUNT(*) as count FROM tasks WHERE user_id = $1 AND is_completed = false
      `, [userId]);

      const tasksCompleted = parseInt(completedResult.rows[0].count, 10);
      const tasksOpen = parseInt(openResult.rows[0].count, 10);

      // Compute plan tasks completed
      const planResult = await pool.query(
        'SELECT task_1_id, task_2_id, task_3_id FROM buddy_daily_plans WHERE user_id = $1 AND plan_date = $2',
        [userId, today]
      );

      if (planResult.rows.length > 0) {
        const plan = planResult.rows[0];
        const planTaskIds = [plan.task_1_id, plan.task_2_id, plan.task_3_id].filter(Boolean);
        let planCompleted = 0;
        if (planTaskIds.length > 0) {
          const compCheck = await pool.query(
            `SELECT id FROM tasks WHERE id = ANY($1) AND is_completed = true`,
            [planTaskIds]
          );
          planCompleted = compCheck.rows.length;
        }
        await pool.query(
          `UPDATE buddy_daily_plans SET tasks_completed = $1 WHERE user_id = $2 AND plan_date = $3`,
          [planCompleted, userId, today]
        );
      }

      const result = await pool.query(`
        INSERT INTO buddy_checkins
          (user_id, checkin_date, checkin_type,
           tasks_completed, tasks_open,
           energy_level, blocks_text,
           tasks_completed_today, routines_kept_today,
           documents_handled, money_tasks_done)
        VALUES ($1, $2, 'evening', $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (user_id, checkin_date, checkin_type)
        DO UPDATE SET
          tasks_completed = EXCLUDED.tasks_completed,
          tasks_open = EXCLUDED.tasks_open,
          energy_level = COALESCE(EXCLUDED.energy_level, buddy_checkins.energy_level),
          blocks_text = COALESCE(EXCLUDED.blocks_text, buddy_checkins.blocks_text),
          tasks_completed_today = COALESCE(EXCLUDED.tasks_completed_today, buddy_checkins.tasks_completed_today),
          routines_kept_today = COALESCE(EXCLUDED.routines_kept_today, buddy_checkins.routines_kept_today),
          documents_handled = COALESCE(EXCLUDED.documents_handled, buddy_checkins.documents_handled),
          money_tasks_done = COALESCE(EXCLUDED.money_tasks_done, buddy_checkins.money_tasks_done)
        RETURNING *
      `, [
        userId, today,
        tasksCompleted, tasksOpen,
        energy_level || null,
        blocks_text || null,
        tasks_completed_today != null ? tasks_completed_today : null,
        routines_kept_today != null ? routines_kept_today : null,
        documents_handled != null ? documents_handled : null,
        money_tasks_done != null ? money_tasks_done : null
      ]);

      res.json({ success: true, checkin: result.rows[0], tasksCompleted, tasksOpen });
    } catch (err) {
      console.error('[buddy] POST /evening error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save evening recap' });
    }
  });

  // ─── GET /api/buddy/patterns ─────────────────────────────────────────────
  // V2B: run pattern detection and return dashboard data.
  // Runs all algorithmic detectors: avoidance, spending correlation, energy,
  // streaks, completion stats. Also generates buddy nudges for avoided tasks.
  router.get('/patterns', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const patterns = await runPatternDetection(pool, userId, tz);
      res.json({ success: true, patterns });
    } catch (err) {
      console.error('[buddy] GET /patterns error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to run pattern detection' });
    }
  });

  // ─── GET /api/buddy/midday-checkin ────────────────────────────────────────
  // V2B: returns which mid-day check-in (if any) should show right now,
  // and whether the user has already responded to it today.
  router.get('/midday-checkin', async (req, res) => {
    try {
      const userId = req.user.id;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);
      // localHour: use query param if client sent it (browser's local hour),
      // otherwise compute from stored timezone for server-side calls.
      const localHour = parseInt(req.query.hour || getUserLocalHour(tz), 10);

      // Get today's accepted plan to compute post-plan timing
      const planResult = await pool.query(
        `SELECT id, accepted, updated_at FROM buddy_daily_plans
         WHERE user_id = $1 AND plan_date = $2 AND accepted = true`,
        [userId, today]
      );
      const plan = planResult.rows[0] || null;
      const planAcceptedAt = plan ? plan.updated_at : null;
      // WHY: planAcceptedAt is a UTC timestamp. getHours() on it returns UTC hour —
      // wrong for non-UTC users. Convert to local hour using the stored timezone.
      const localAcceptedHour = planAcceptedAt
        ? getUserLocalHour(tz, new Date(planAcceptedAt))
        : undefined;

      const checkinType = getMidDayCheckinType(localHour, planAcceptedAt, localAcceptedHour);

      if (!checkinType) {
        return res.json({ success: true, checkinType: null, alreadyDone: false });
      }

      // Check if user already responded today
      const existingResult = await pool.query(
        `SELECT id FROM buddy_midday_checkins
         WHERE user_id = $1 AND checkin_date = $2 AND checkin_type = $3
         LIMIT 1`,
        [userId, today, checkinType]
      );
      const alreadyDone = existingResult.rows.length > 0;

      // For post_plan: include remaining tasks so frontend can render re-rank UI
      let remainingSlots = null;
      if (!alreadyDone && checkinType === 'post_plan' && plan) {
        const enriched = await enrichPlan(plan, pool);
        // Filter to only incomplete tasks
        remainingSlots = enriched.slots.filter(s => s && s.task && !s.task.is_completed);
      }

      res.json({ success: true, checkinType, alreadyDone, planId: plan ? plan.id : null, remainingSlots });
    } catch (err) {
      console.error('[buddy] GET /midday-checkin error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to check mid-day status' });
    }
  });

  // ─── POST /api/buddy/midday-checkin ───────────────────────────────────────
  // V2B: store user's mid-day check-in response.
  // body: { checkin_type, plan_id, response }
  router.post('/midday-checkin', async (req, res) => {
    try {
      const userId = req.user.id;
      const { checkin_type, plan_id, response } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = getUserLocalDate(tz);

      if (!checkin_type) {
        return res.status(400).json({ success: false, message: 'checkin_type required' });
      }

      const result = await pool.query(`
        INSERT INTO buddy_midday_checkins
          (user_id, checkin_type, plan_id, response, checkin_date)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [userId, checkin_type, plan_id || null, response ? JSON.stringify(response) : null, today]);

      res.json({ success: true, checkin: result.rows[0] });
    } catch (err) {
      console.error('[buddy] POST /midday-checkin error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save mid-day check-in' });
    }
  });

  // ─── GET /api/buddy/mode-preference ──────────────────────────────────────
  // V4: return which check-in mode to show this session.
  // Logic: first 5 sessions alternate form/conversation. Session 6+: use learned preference.
  // Returns: { mode: 'form'|'conversation', learned: bool, stats }
  router.get('/mode-preference', async (req, res) => {
    try {
      const userId = req.user.id;
      const prefResult = await pool.query(
        `SELECT * FROM checkin_mode_preferences WHERE user_id = $1`,
        [userId]
      );

      // New user — no preference record yet
      if (!prefResult.rows.length) {
        return res.json({
          success: true,
          mode: 'conversation', // default first session to conversation
          learned: false,
          totalSessions: 0,
          preferredMode: null
        });
      }

      const pref = prefResult.rows[0];

      // Manual override always wins
      if (pref.manual_override) {
        return res.json({
          success: true,
          mode: pref.manual_override,
          learned: true,
          totalSessions: pref.total_sessions,
          preferredMode: pref.preferred_mode
        });
      }

      let mode;
      // Alternating phase: first 5 sessions alternate form / conversation
      if (pref.total_sessions < 5) {
        mode = pref.total_sessions % 2 === 0 ? 'conversation' : 'form';
      } else if (pref.preferred_mode) {
        // Learned preference
        mode = pref.preferred_mode;
      } else {
        // Fallback: default to conversation
        mode = 'conversation';
      }

      res.json({
        success: true,
        mode,
        learned: pref.total_sessions >= 5 && !!pref.preferred_mode,
        totalSessions: pref.total_sessions,
        preferredMode: pref.preferred_mode
      });
    } catch (err) {
      console.error('[buddy] GET /mode-preference error:', err.message);
      // Fail open — default to conversation
      res.json({ success: true, mode: 'conversation', learned: false, totalSessions: 0 });
    }
  });

  // ─── POST /api/buddy/mode-preference ─────────────────────────────────────
  // V4: record session outcome + update learned preference.
  // body: { mode: 'form'|'conversation', completed: bool, skipped: bool, manual_override?: string }
  router.post('/mode-preference', async (req, res) => {
    try {
      const userId = req.user.id;
      const { mode, completed, skipped, manual_override } = req.body;

      if (manual_override && ['form', 'conversation'].includes(manual_override)) {
        // User explicitly switched mode — record as override, don't affect stats
        await pool.query(`
          INSERT INTO checkin_mode_preferences (user_id, manual_override, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id) DO UPDATE
            SET manual_override = EXCLUDED.manual_override,
                updated_at = NOW()
        `, [userId, manual_override]);
        return res.json({ success: true, mode: manual_override });
      }

      if (!mode || !['form', 'conversation'].includes(mode)) {
        return res.status(400).json({ success: false, message: 'mode must be form or conversation' });
      }

      // Increment appropriate counters
      const sessionCol   = mode === 'form' ? 'form_sessions'    : 'conv_sessions';
      const completedCol = mode === 'form' ? 'form_completions' : 'conv_completions';
      const skippedCol   = mode === 'form' ? 'form_skips'       : 'conv_skips';

      await pool.query(`
        INSERT INTO checkin_mode_preferences
          (user_id, ${sessionCol}, ${completedCol}, ${skippedCol}, total_sessions, updated_at)
        VALUES ($1, 1, $2, $3, 1, NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET ${sessionCol}   = checkin_mode_preferences.${sessionCol} + 1,
              ${completedCol} = checkin_mode_preferences.${completedCol} + $2,
              ${skippedCol}   = checkin_mode_preferences.${skippedCol} + $3,
              total_sessions  = checkin_mode_preferences.total_sessions + 1,
              updated_at = NOW()
      `, [userId, completed ? 1 : 0, skipped ? 1 : 0]);

      // Compute preference after session 5+
      const prefResult = await pool.query(
        `SELECT * FROM checkin_mode_preferences WHERE user_id = $1`,
        [userId]
      );
      const pref = prefResult.rows[0];

      let newPreference = null;
      if (pref && pref.total_sessions >= 5) {
        // Completion rate is primary signal; skip rate as tiebreaker
        const formRate = pref.form_sessions > 0 ? pref.form_completions / pref.form_sessions : 0;
        const convRate = pref.conv_sessions > 0 ? pref.conv_completions / pref.conv_sessions : 0;
        const formSkipRate = pref.form_sessions > 0 ? pref.form_skips / pref.form_sessions : 1;
        const convSkipRate = pref.conv_sessions > 0 ? pref.conv_skips / pref.conv_sessions : 1;

        const formScore = formRate - formSkipRate * 0.5;
        const convScore = convRate - convSkipRate * 0.5;

        // Only update preference if we have data from both modes
        if (pref.form_sessions >= 2 && pref.conv_sessions >= 2) {
          newPreference = formScore >= convScore ? 'form' : 'conversation';
        } else if (pref.form_sessions >= 1 && pref.conv_sessions >= 1) {
          newPreference = formScore > convScore ? 'form' : 'conversation';
        }

        if (newPreference && newPreference !== pref.preferred_mode) {
          await pool.query(
            `UPDATE checkin_mode_preferences SET preferred_mode = $1, updated_at = NOW() WHERE user_id = $2`,
            [newPreference, userId]
          );
        }
      }

      res.json({ success: true, preferredMode: newPreference || (pref && pref.preferred_mode) });
    } catch (err) {
      console.error('[buddy] POST /mode-preference error:', err.message);
      res.json({ success: true }); // fail open
    }
  });

  // ─── POST /api/buddy/brain-dump-tasks ────────────────────────────────────
  // V5: parse brain-dump text into candidate tasks using shared taskParser engine.
  // Also detects completions: if user mentions having done something, auto-marks
  // the matching open task complete and returns it in the `completions` array.
  // body: { text: string, date?: string }
  router.post('/brain-dump-tasks', async (req, res) => {
    try {
      const userId = req.user.id;
      const { text, date } = req.body;
      const tz = await fetchUserTimezone(pool, userId);
      const today = date || getUserLocalDate(tz);

      if (!text || !text.trim()) {
        return res.status(400).json({ success: false, message: 'text required' });
      }

      // Load user's values for tagging + active tasks for completion detection
      const [valuesResult, activeTasksResult] = await Promise.all([
        pool.query(
          `SELECT id, value_name FROM user_values WHERE user_id = $1 ORDER BY rank ASC LIMIT 10`,
          [userId]
        ),
        pool.query(
          `SELECT id, title FROM tasks WHERE user_id = $1 AND is_completed = false AND ${actionableDateFilter(2)} ORDER BY created_at DESC LIMIT 50`,
          [userId, today]
        )
      ]);
      const userValues = valuesResult.rows;
      const activeTasks = activeTasksResult.rows;

      // Run extraction + completion detection in parallel
      const [extractedTasks, completionMatches] = await Promise.all([
        extractTasks(text.trim(), userValues),
        detectCompletions(text.trim(), activeTasks)
      ]);

      // Apply auto-completions: mark matched tasks complete in DB
      const autoCompleted = [];
      for (const match of completionMatches) {
        if (match.match_type === 'complete') {
          try {
            const result = await pool.query(
              `UPDATE tasks SET is_completed = true, completed_at = NOW()
               WHERE id = $1 AND user_id = $2 AND is_completed = false
               RETURNING id, title`,
              [match.task_id, userId]
            );
            if (result.rows.length > 0) {
              autoCompleted.push({
                task_id: match.task_id,
                title: result.rows[0].title,
                matched_phrase: match.matched_phrase || null,
                followup_task_title: match.followup_task_title || null
              });
            }
          } catch (completionErr) {
            console.error('[buddy] brain-dump auto-completion error:', completionErr.message);
          }
        }
      }

      // Limit to 8 extracted tasks (reasonable for a brain dump)
      const tasks = extractedTasks.slice(0, 8);

      res.json({ success: true, tasks, completions: autoCompleted });
    } catch (err) {
      console.error('[buddy] POST /brain-dump-tasks error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to parse brain dump' });
    }
  });

  // ─── POST /api/buddy/break-down ──────────────────────────────────────────
  // "I'm stuck": Buddy breaks a task into ADHD-appropriate micro-steps (< 1 min each).
  // Persists steps to task_substeps so the user can continue after page refresh.
  // body: { taskId, taskTitle, taskDescription? }
  // Returns: { steps: [{ id, text, order, completed }] }
  router.post('/break-down', async (req, res) => {
    try {
      const userId = req.user.id;
      const { taskId, taskTitle, taskDescription } = req.body;

      if (!taskId || !taskTitle || !taskTitle.trim()) {
        return res.status(400).json({ success: false, message: 'taskId and taskTitle required' });
      }

      // Validate the task belongs to this user and is not completed
      const taskCheck = await pool.query(
        'SELECT id, title FROM tasks WHERE id = $1 AND user_id = $2 AND is_completed = false',
        [taskId, userId]
      );
      if (!taskCheck.rows.length) {
        return res.status(404).json({ success: false, message: 'Task not found or already complete' });
      }

      const systemPrompt = `You are a task decomposition assistant for adults with ADHD.
Break the given task into the smallest possible concrete steps.

Rules:
- Each step must be a PHYSICAL ACTION (open, click, write, pick up, walk to...)
- Each step must take LESS THAN 1 MINUTE to complete
- Use simple, direct language — no jargon
- 3-8 steps is ideal. More than 10 means you are over-breaking
- First step should be the absolute smallest possible starting action (e.g., "Open the app" or "Pick up the pen")
- Never use "think about" or "consider" or "plan" — those are not actions
- Never use "etc." or "and so on" — be specific
- Return ONLY a valid JSON array of strings, no markdown, no explanation

Example output: ["Walk to the kitchen","Pick up one item from the counter","Put it where it belongs","Repeat with the next item"]`;

      const userContent = taskTitle.trim() +
        (taskDescription && taskDescription.trim() ? '\n\nContext: ' + taskDescription.trim() : '');

      let steps = [];
      try {
        const raw = await chatMessages(
          [{ role: 'user', content: userContent }],
          { system: systemPrompt, maxTokens: 400 }
        );
        // Parse JSON array from AI response
        const cleaned = raw.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'');
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
          steps = parsed
            .filter(function(s) { return typeof s === 'string' && s.trim(); })
            .slice(0, 10)
            .map(function(text, i) { return { text: text.trim(), order: i + 1 }; });
        }
      } catch (aiErr) {
        console.error('[buddy] break-down AI error:', aiErr.message);
        // Provide a minimal fallback so the user is never stranded
        steps = [
          { text: 'Open whatever you need to start this task', order: 1 },
          { text: 'Take the very first small action', order: 2 },
          { text: 'Do the next small action', order: 3 }
        ];
      }

      if (!steps.length) {
        steps = [
          { text: 'Open whatever you need to start this task', order: 1 },
          { text: 'Take the very first small action', order: 2 }
        ];
      }

      // Persist to DB (overwrites any previous breakdown for this task)
      await saveSubsteps(pool, userId, taskId, steps);

      // Re-fetch to include DB ids
      const saved = await getSubsteps(pool, userId, taskId);

      res.json({
        success: true,
        steps: saved.map(function(s) {
          return { id: s.id, text: s.step_text, order: s.step_order, completed: s.completed };
        })
      });
    } catch (err) {
      console.error('[buddy] POST /break-down error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to break down task' });
    }
  });

  // ─── GET /api/buddy/substeps/:taskId ─────────────────────────────────────
  // Fetch persisted substeps for a task (allows resuming mid-flow).
  router.get('/substeps/:taskId', async (req, res) => {
    try {
      const userId = req.user.id;
      const taskId = parseInt(req.params.taskId, 10);
      if (!taskId) return res.status(400).json({ success: false, message: 'taskId required' });

      const rows = await getSubsteps(pool, userId, taskId);
      res.json({
        success: true,
        steps: rows.map(function(s) {
          return { id: s.id, text: s.step_text, order: s.step_order, completed: s.completed };
        })
      });
    } catch (err) {
      console.error('[buddy] GET /substeps error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to fetch substeps' });
    }
  });

  // ─── POST /api/buddy/substeps/:substepId/toggle ───────────────────────────
  // Mark a substep complete or incomplete.
  // If all substeps complete → auto-complete the parent task.
  // body: { completed: boolean }
  // Returns: { substep, parentCompleted }
  router.post('/substeps/:substepId/toggle', async (req, res) => {
    try {
      const userId = req.user.id;
      const substepId = parseInt(req.params.substepId, 10);
      const { completed } = req.body;

      if (!substepId || typeof completed !== 'boolean') {
        return res.status(400).json({ success: false, message: 'substepId and completed (boolean) required' });
      }

      const updated = await toggleSubstep(pool, userId, substepId, completed);
      if (!updated) return res.status(404).json({ success: false, message: 'Substep not found' });

      // Check if all done — if so, auto-complete parent task
      let parentCompleted = false;
      if (completed) {
        const status = await checkAllDone(pool, userId, updated.task_id);
        if (status.allDone) {
          const taskUpdate = await pool.query(
            `UPDATE tasks SET is_completed = true, completed_at = NOW()
             WHERE id = $1 AND user_id = $2 AND is_completed = false
             RETURNING id, title`,
            [updated.task_id, userId]
          );
          parentCompleted = taskUpdate.rows.length > 0;
        }
      }

      res.json({
        success: true,
        substep: { id: updated.id, text: updated.step_text, order: updated.step_order, completed: updated.completed },
        parentCompleted
      });
    } catch (err) {
      console.error('[buddy] POST /substeps/toggle error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to toggle substep' });
    }
  });

  // ─── POST /api/buddy/confirm-tasks ───────────────────────────────────────
  // V4: user confirmed parsed tasks — insert into tasks table.
  // body: { tasks: [{ title, priority, value_id }] }
  router.post('/confirm-tasks', async (req, res) => {
    try {
      const userId = req.user.id;
      const { tasks } = req.body;

      if (!Array.isArray(tasks) || !tasks.length) {
        return res.status(400).json({ success: false, message: 'tasks array required' });
      }

      const created = [];
      for (const t of tasks.slice(0, 10)) {
        if (!t || !t.title || !t.title.trim()) continue;
        try {
          const r = await pool.query(
            `INSERT INTO tasks (user_id, title, priority, value_id, is_completed, created_at)
             VALUES ($1, $2, $3, $4, false, NOW())
             RETURNING id, title, priority`,
            [
              userId,
              t.title.trim().slice(0, 200),
              ['low','medium','high'].includes(t.priority) ? t.priority : 'medium',
              t.value_id || null
            ]
          );
          created.push(r.rows[0]);
        } catch (insertErr) {
          console.error('[buddy] confirm-tasks insert error:', insertErr.message);
        }
      }

      res.json({ success: true, created, count: created.length });
    } catch (err) {
      console.error('[buddy] POST /confirm-tasks error:', err.message);
      res.status(500).json({ success: false, message: 'Failed to save tasks' });
    }
  });

  return router;
};

// ── Plan generation ──────────────────────────────────────────────────────────
// Queries relevant incomplete tasks (due today/overdue/within 3 days/no due date),
// scores them, picks top 3, stores in DB.
async function generatePlan(userId, today, mood, pool) {
  // Fetch only tasks relevant to the check-in window:
  // overdue, due today, due within 3 days, or no due date.
  // Tasks due 4+ days out are excluded — showing them during check-in adds noise
  // without being actionable; they'll surface naturally as their date approaches.
  // Uses shared actionableDateFilter — DO NOT inline a separate copy of this filter.
  const tasksResult = await pool.query(`
    SELECT id, title, due_date, created_at, priority, value_id
    FROM tasks
    WHERE user_id = $1
      AND is_completed = false
      AND ${actionableDateFilter(2)}
    ORDER BY created_at ASC
  `, [userId, today]);

  const tasks = tasksResult.rows;

  // Fetch user values for alignment scoring
  const valuesResult = await pool.query(
    `SELECT id, value_name, rank FROM user_values WHERE user_id = $1 ORDER BY rank ASC LIMIT 10`,
    [userId]
  );
  const userValues = valuesResult.rows;

  // Score and sort
  const scored = scoreTasks(tasks, mood || 'okay', today, userValues);

  // Take top 3 (de-duplicated — scoreTasks already returns unique tasks)
  const top3 = scored.slice(0, 3);

  // Fill nulls if fewer than 3 tasks exist
  const slots = [0, 1, 2].map(i => top3[i] || null);

  // Store plan
  const insertResult = await pool.query(`
    INSERT INTO buddy_daily_plans
      (user_id, plan_date, mood,
       task_1_id, task_1_reason,
       task_2_id, task_2_reason,
       task_3_id, task_3_reason)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (user_id, plan_date) DO UPDATE
      SET mood = EXCLUDED.mood,
          task_1_id = EXCLUDED.task_1_id, task_1_reason = EXCLUDED.task_1_reason,
          task_2_id = EXCLUDED.task_2_id, task_2_reason = EXCLUDED.task_2_reason,
          task_3_id = EXCLUDED.task_3_id, task_3_reason = EXCLUDED.task_3_reason,
          accepted = false, tasks_completed = 0
    RETURNING *
  `, [
    userId, today, mood || null,
    slots[0]?.task?.id || null, slots[0]?.reason || null,
    slots[1]?.task?.id || null, slots[1]?.reason || null,
    slots[2]?.task?.id || null, slots[2]?.reason || null,
  ]);

  const plan = insertResult.rows[0];

  return {
    plan,
    slots: slots.map(s => s ? {
      task: s.task,
      reason: s.reason,
      activation: s.activation
    } : null)
  };
}

// ── Enrich plan with task details ────────────────────────────────────────────
// Fetches task titles for an existing plan record.
async function enrichPlan(plan, pool) {
  const ids = [plan.task_1_id, plan.task_2_id, plan.task_3_id].filter(Boolean);
  if (!ids.length) return { slots: [null, null, null] };

  const taskResult = await pool.query(
    `SELECT id, title, priority, is_completed FROM tasks WHERE id = ANY($1)`,
    [ids]
  );
  const byId = {};
  taskResult.rows.forEach(t => { byId[t.id] = t; });

  const slots = [1, 2, 3].map(n => {
    const taskId = plan[`task_${n}_id`];
    const reason = plan[`task_${n}_reason`];
    const task = taskId ? byId[taskId] : null;
    if (!task) return null;
    return {
      task,
      reason: reason || 'Ready to do',
      activation: task.priority === 'low' ? 'Low' : task.priority === 'high' ? 'High' : 'Medium'
    };
  });

  return { slots };
}

// ── V3 Coaching Conversation Helpers ─────────────────────────────────────────

// Build the system prompt for each phase of the coaching conversation.
// Session-gated progressive hook:
//   Sessions 1-2: Pure Coaching Habit (deliberate onboarding sequence)
//   Sessions 3-8: Progressive insights + structured coaching
//   Sessions 9+:  Variety engine (randomized openers, breaking fixed patterns)
// greetingContext: up to 2 cross-domain observations from buildGreetingContext()
// partnerCtx: Tandem partner awareness (shared task signals, concern topics) — null if no Tandem
// sessionCount: user's lifetime session count (0-indexed — 0 = first session)
// hookRestartCount: number of times the hook has been restarted (0 = original run)
function buildConversationSystemPrompt(userTurnNumber, greetingContext, partnerCtx, sessionCount, hookRestartCount) {
  const base = `You are Buddy — an ADHD coaching assistant for FocusLedger. You follow The Coaching Habit framework.
Your style: warm, direct, no fluff. Short sentences. No "Great question!" or sycophancy. No wizard-style scripted phrases.
You never shame. You never force positivity. You meet people where they are.
Keep responses under 60 words. Ask ONE question at a time.
React to what the person actually said — don't stick to a script.`;

  // Partner context addition (Tandem users only) — appended to relevant turns
  const partnerAddition = buildPartnerContextPromptAddition(partnerCtx);
  const sc = sessionCount || 0;
  const isRestart = (hookRestartCount || 0) > 0;

  // ── Sessions 1-2: Pure Coaching Habit ───────────────────────────────────────
  // Deliberate onboarding hook — no randomization, no variety.
  // Day 1: "What's on your mind?" → "And what else?" → "What's the real challenge?"
  // Day 2: Reference yesterday → dig deeper → land on intention
  // Restart variant: warm fresh-start framing, no reference to "original" sequence.
  if (sc <= 2) {
    if (userTurnNumber === 1) {
      let day2Note;
      if (isRestart && sc === 0) {
        // Hook restarted — user is back after a lapse. Warm, no guilt, fresh start.
        day2Note = `\n\nThis user is returning after a break. They've used Buddy before but stepped away for a bit. The client greeted them with a fresh-start message. Your opener should feel like a warm welcome back, not a restart. Try: "Hey — fresh start. No catching up needed. What's on your mind right now?" Stay curious, not scripted.`;
      } else if (sc === 1) {
        day2Note = `\n\nThis is the user's SECOND session. They came back! The client already greeted them with a reference to yesterday's conversation. Your job: acknowledge what they share and dig deeper. Ask "And what else?" — genuinely curious, not formulaic.`;
      } else {
        day2Note = `\n\nThis is the user's FIRST session ever. They just told you what's on their mind. Your job: listen, validate briefly, then ask "And what else?" to go deeper. Keep it warm and curious.`;
      }
      return base + day2Note + partnerAddition;
    } else if (userTurnNumber === 2) {
      return base + `\n\nSecond exchange in the Coaching Habit flow. Read what they actually said. Now ask: "What's the real challenge here for you?" — paraphrase it to fit their words. Don't use that exact phrase if it sounds robotic; match their energy. The goal is to help them name the ONE thing underneath everything.` + partnerAddition;
    } else if (userTurnNumber === 3) {
      return base + `\n\nThird exchange. They've named the real challenge. Help them land on ONE concrete intention for today. "If you got one thing done today, what would make it feel worth it?" Validate what they shared — reference something specific.`;
    } else {
      return base + `\n\nFinal exchange. Wrap up warmly. Confirm the key thing they want to focus on. Don't over-summarize — just name what matters.
End your message with exactly "[[CONVERSATION_COMPLETE]]" on its own line after your closing words.`;
    }
  }

  // ── Sessions 3-8: Progressive insights + structured coaching ────────────────
  // Cross-domain observations surface in the opener, but conversation still
  // follows structured Coaching Habit bones. No randomization yet.
  if (sc <= 8) {
    if (userTurnNumber === 1) {
      let openerGuidance = '';
      if (greetingContext && greetingContext.length > 0) {
        const obs = greetingContext[0];
        const obsText = typeof obs === 'string' ? obs : (obs.observation || obs.text || JSON.stringify(obs));
        openerGuidance = `\n\nYou have this cross-domain observation about the user: "${obsText}"
The client already surfaced it as a greeting. Acknowledge what they said, then dig deeper with "And what else?" or "What's underneath that?" — the Coaching Habit way.
If they sound overwhelmed, acknowledge the emotion FIRST before anything else.`;
      } else {
        openerGuidance = `\n\nThis is a returning user (session ${sc}). The client showed a greeting. Your job: read what they shared and go deeper. Ask "And what else?" or "What's on your mind beyond that?" — curious and warm, not scripted.`;
      }
      return base + openerGuidance + partnerAddition;
    } else if (userTurnNumber === 2) {
      return base + `\n\nSecond exchange. Read what the user actually said. If they sound stressed or emotional, respond to the emotion first — don't skip to task-finding.
Help them name the real thing: "What's the part that's actually stressing you out?" or "Is there one thing underneath all of this?"` + partnerAddition;
    } else if (userTurnNumber === 3) {
      return base + `\n\nThird exchange. Help them land on something concrete. ONE actionable intention for today.
"If you got one thing done today, what would make it feel worth it?" or "What's the one move that would feel like progress?"
Validate what they've shared — reference something they actually said.`;
    } else {
      return base + `\n\nFinal exchange. Wrap up warmly. Confirm the key thing(s) they want to focus on. Don't summarize everything — just name what matters.
End your message with exactly "[[CONVERSATION_COMPLETE]]" on its own line after your closing words.`;
    }
  }

  // ── Sessions 9+: Variety engine ─────────────────────────────────────────────
  // User has completed the progressive hook. Now vary entry points to prevent
  // ADHD pattern-matching disengagement. Randomized openers, values nudges,
  // emotional acknowledgment, due date leads.
  if (userTurnNumber === 1) {
    let openerGuidance = '';
    if (greetingContext && greetingContext.length > 0) {
      const obs = greetingContext[0];
      const obsText = typeof obs === 'string' ? obs : (obs.observation || obs.text || JSON.stringify(obs));
      openerGuidance = `\n\nYou have this cross-domain observation about the user: "${obsText}"
Use it as your opener if it fits naturally — lead with something specific instead of a generic mood check.
If the user sounds overwhelmed or emotional in their first message, acknowledge that FIRST before referencing the observation.
Do NOT start with "How are you feeling?" or "What's on your mind?" — be more specific and human.`;
    } else {
      openerGuidance = `\n\nThis is the opening turn. Do NOT start with "How are you feeling?" or "What's on your mind today?" — those are overused.
Instead, try one of these openers (pick the one that fits):
- If they just brain-dumped: acknowledge one specific thing they mentioned, then invite more
- If they seem overwhelmed: acknowledge the overwhelm before asking anything
- Ask "What's actually taking up space in your head right now?" or "What happened since we last talked?" or similar
The goal: get them talking about what's real, not performing a wellness check-in.`;
    }
    return base + openerGuidance + partnerAddition;
  } else if (userTurnNumber === 2) {
    return base + `\n\nSecond exchange. Read what the user actually said. If they sound stressed or emotional, respond to the emotion first — don't skip to task-finding.
If they're giving you context, focus it: "What's the part that's actually stressing you out?" or "Is there one thing underneath all of this?"
Don't ask "What's the real challenge here?" verbatim — paraphrase it to fit what they shared.` + partnerAddition;
  } else if (userTurnNumber === 3) {
    return base + `\n\nThird exchange. Help them land on something concrete. ONE actionable intention for today.
Phrase it as a question: "If you got one thing done today, what would make it feel worth it?" or "What's the one move that would feel like progress?"
Validate what they've shared. Be specific — reference something they actually said.`;
  } else {
    return base + `\n\nFinal exchange. Wrap up warmly. Confirm the key thing(s) they want to focus on. Don't summarize everything — just name what matters.
End your message with exactly "[[CONVERSATION_COMPLETE]]" on its own line after your closing words.`;
  }
}

// Fallback Buddy replies when AI is unavailable.
function getFallbackBuddyReply(userTurnNumber) {
  const fallbacks = [
    'Got it. And what else is on your mind?',
    'What feels like the real challenge underneath that?',
    'What\'s the one thing that would make today feel worth it?',
    'I\'ve got what I need. Let\'s build your plan. [[CONVERSATION_COMPLETE]]'
  ];
  return fallbacks[Math.min(userTurnNumber - 1, fallbacks.length - 1)];
}

// Infer mood from conversation text (keyword-based, no external dependency).
function inferMoodFromText(messages) {
  const text = messages.map(function(m) { return m.message || ''; }).join(' ').toLowerCase();
  if (/overwhelm|anxious|anxiety|stress|panic|spiraling/.test(text)) return 'okay';
  if (/tired|exhaust|drain|sluggish|no energy|barely/.test(text)) return 'foggy';
  if (/awful|terrible|struggl|hard day|can\'t/.test(text)) return 'struggling';
  if (/great|amazing|energized|crush|pumped|ready/.test(text)) return 'energized';
  if (/good|solid|fine|alright|okay/.test(text)) return 'good';
  return 'okay'; // safe default
}

// Build the prompt for generating first-session insights + starter tasks.
function buildInsightsPrompt(userMessages, values) {
  const conversation = userMessages.map(function(m, i) { return (i + 1) + '. ' + m; }).join('\n');
  const valuesStr = values.length ? values.join(', ') : 'not set yet';
  return `A new FocusLedger user just completed their first check-in conversation. Here's what they said:

${conversation}

Their stated values: ${valuesStr}

Based on what they shared:
1. Write ONE personalized insight (2-3 sentences). Reference something specific they mentioned. Connect it to a practical action or framing. Sound like a good coach, not a wellness app.
2. Generate 3-5 starter tasks that make sense given what they shared. These should be concrete and actionable — real things they could actually do. Short titles (under 60 chars each).

Return ONLY valid JSON in this exact format:
{"insight":"your insight here","tasks":["Task 1","Task 2","Task 3"]}`;
}

// ── archiveBuddyConversationToJournal ─────────────────────────────────────────
// Saves a clean narrative summary of a completed check-in to journal_entries.
// Entry is readable on its own — written for humans, not machines.
// Skips silently if a journal entry already exists for this user+date to avoid dupes.
async function archiveBuddyConversationToJournal(pool, userId, dateStr, userMessages, mood, buddyLastReply) {
  // Don't create a second archive if one was already made today
  const existing = await pool.query(
    `SELECT id FROM journal_entries
     WHERE user_id = $1
       AND entry_type = 'buddy_checkin'
       AND created_at::date = $2::date
     LIMIT 1`,
    [userId, dateStr]
  );
  if (existing.rows.length > 0) return;

  // Format date for display (e.g. "May 14")
  const dateObj = new Date(dateStr + 'T12:00:00Z');
  const dateLabel = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  // Mood label
  const moodLabel = mood ? ` · Mood: ${mood}` : '';

  // Build readable summary from user messages
  const keyTopics = userMessages
    .map(function(m) { return m.trim(); })
    .filter(function(m) { return m.length > 0; })
    .slice(0, 4)
    .join(' — ');

  // Buddy's final insight (strip trailing [[CONVERSATION_COMPLETE]] if present)
  const buddyInsight = (buddyLastReply || '')
    .replace('[[CONVERSATION_COMPLETE]]', '')
    .trim();

  const content = `**${dateLabel} Check-In**${moodLabel}\n\n${keyTopics}${buddyInsight ? `\n\nBuddy: "${buddyInsight}"` : ''}`;

  await pool.query(
    `INSERT INTO journal_entries (user_id, content, entry_type, created_at)
     VALUES ($1, $2, 'buddy_checkin', NOW())`,
    [userId, content]
  );
}

// buildBrainDumpPrompt removed — logic now lives in lib/taskParser.js (extractTasks)

// ── Tandem Partner Context Builder ────────────────────────────────────────────
// Gathers partner awareness signals for Buddy's coaching context.
// PRIVACY RULES (strictly enforced here):
//   - Only shared (is_household=true OR is_shared_with_partner=true) tasks are counted.
//   - Private task count, titles, and status NEVER leak — not even as aggregated numbers.
//   - Partner concern text is NEVER passed to AI. Only topic area (a short category string).
//   - Returns null if no active Tandem partnership or Tandem access not active.
//
// Returns: { partnerName, sharedOverdue, sharedDoneToday, concernTopics }
// or null if Tandem not applicable for this user.
async function buildPartnerContext(pool, userId, today) {
  try {
    // Check Tandem access — only inject partner context if access is active
    const access = await checkTandemAccess(pool, userId);
    if (!access.hasTandem) return null;

    const partnership = await getActivePartnership(pool, userId);
    if (!partnership) return null;

    const partnerId = partnership.partner_id;
    const partnerName = (partnership.partner_name || '').split(' ')[0] || 'your partner';

    // Count ONLY shared/household tasks — private tasks are invisible here.
    // This is the privacy firewall: aggregated counts only reflect what the partner
    // explicitly chose to share.
    const [overdueResult, doneTodayResult, totalSharedResult, concernsResult] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) AS count FROM tasks
        WHERE user_id = $1
          AND is_completed = false
          AND (is_household = true OR is_shared_with_partner = true)
          AND due_date < $2::date
      `, [partnerId, today]),

      pool.query(`
        SELECT COUNT(*) AS count FROM tasks
        WHERE user_id = $1
          AND is_completed = true
          AND completed_at::date = $2::date
          AND (is_household = true OR is_shared_with_partner = true)
      `, [partnerId, today]),

      pool.query(`
        SELECT COUNT(*) AS count FROM tasks
        WHERE user_id = $1
          AND is_completed = false
          AND (is_household = true OR is_shared_with_partner = true)
      `, [partnerId]),

      getActiveConcernsAboutUser(pool, userId),
    ]);

    const sharedOverdue = parseInt(overdueResult.rows[0].count, 10);
    const sharedDoneToday = parseInt(doneTodayResult.rows[0].count, 10);
    void totalSharedResult; // fetched for future analytics; not yet used in prompt
    const concernTopics = concernsResult.map(c => c.topic_area).filter(Boolean);

    return { partnerName, sharedOverdue, sharedDoneToday, concernTopics };
  } catch (_) {
    // Non-blocking — Buddy works fine without partner context
    return null;
  }
}

// Build the partner-aware addition to the Buddy system prompt.
// Called from buildConversationSystemPrompt when partnerCtx is present.
// HARD RULES:
//   - Never quote or paraphrase the partner's concern text.
//   - Never say "your partner told me" or "your partner asked me to".
//   - Frame everything as Buddy's own observation.
//   - Only surface one signal per conversation (the most relevant one).
function buildPartnerContextPromptAddition(partnerCtx) {
  if (!partnerCtx) return '';

  const { partnerName, sharedOverdue, sharedDoneToday, concernTopics } = partnerCtx;
  const lines = [];

  lines.push(`\n\n--- Tandem Partner Awareness (internal coaching context — DO NOT reveal source) ---`);
  lines.push(`You're aware that ${partnerName} is this user's accountability partner.`);

  // Shared task signals — only mention if there's something worth surfacing
  if (sharedOverdue > 0 && sharedDoneToday > 0) {
    lines.push(`${partnerName} has ${sharedOverdue} overdue shared task${sharedOverdue !== 1 ? 's' : ''} but also got ${sharedDoneToday} done today — a mixed day.`);
    lines.push(`You may naturally mention solidarity if the user sounds discouraged — "looks like ${partnerName} had a mixed day too" or similar. Never surveillance tone.`);
  } else if (sharedOverdue > 0) {
    lines.push(`${partnerName} has ${sharedOverdue} overdue shared task${sharedOverdue !== 1 ? 's' : ''} right now.`);
    lines.push(`If the user seems to be struggling alone, you may gently mention shared struggle: "Sounds like ${partnerName} is in the thick of it too." Warm solidarity, not reporting.`);
  } else if (sharedDoneToday > 0) {
    lines.push(`${partnerName} already completed ${sharedDoneToday} shared task${sharedDoneToday !== 1 ? 's' : ''} today.`);
    lines.push(`If a win-sharing moment fits naturally, you can surface it: "You and ${partnerName} are both making moves today." Only if the conversation mood warrants it.`);
  }

  // Partner concern topics — topic area only, never the verbatim concern text
  // CRITICAL: Do NOT say "your partner is worried about you" or "your partner told me"
  if (concernTopics.length > 0) {
    const topic = concernTopics[0]; // Use only the most recent concern topic
    lines.push(`There's a soft signal that ${topic} may be an area worth gently exploring in this conversation.`);
    lines.push(`Weave it in naturally using your coaching style (Break-it-Down, values check, open question). NEVER say "your partner mentioned" or "I was asked to bring this up." Frame it as your own coaching instinct.`);
  }

  lines.push(`HARD RULES: Never quote partner's words. Never say "your partner told me/asked me/is worried." Never share Buddy conversation content between partners. This context is YOUR coaching awareness only.`);
  lines.push(`--- End partner awareness ---`);

  return lines.join('\n');
}
