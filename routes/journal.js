/**
 * Journal API — Evening reflection with AI-powered task auto-completion
 *
 * POST   /api/journal              — submit a new journal entry (triggers AI parsing)
 * GET    /api/journal              — list past journal entries for the current user
 * GET    /api/journal/:id          — single entry with its AI matches
 * POST   /api/journal/:id/approve  — approve AI matches → auto-complete matched tasks
 * POST   /api/journal/:id/matches/:matchId/approve  — approve single match
 * POST   /api/journal/:id/matches/:matchId/dismiss  — dismiss single match
 * POST   /api/journal/:id/matches/:matchId/undo     — undo a task completion
 *
 * Confidence thresholds (from research task #1130910):
 *   ≥0.85  → suggest auto-complete ("Complete this task?")
 *   0.60–0.84 → show as "Did you mean...?" suggestion
 *   <0.60  → ignored (no false positives)
 *
 * Partial completion detection:
 *   "Started the tax stuff but didn't finish" → progress note logged, task NOT completed
 *   "Called dentist but need to call back Thursday" → complete original + create follow-up
 */

const express = require('express');
const { complete } = require('../lib/claude-client');
const { authenticateToken } = require('../middleware/auth');

const _CONFIDENCE_HIGH = 0.85;   // Suggest auto-complete (comment reference only; threshold enforced in AI prompt)
const CONFIDENCE_MED  = 0.60;    // "Did you mean?" suggestion
const AI_TIMEOUT_MS   = 12000;   // 12s — longer than suggestions because NLP is heavier

module.exports = function(pool) {
  const router = express.Router();
  router.use(authenticateToken);

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Fetch user's active tasks for matching
   */
  async function getActiveTasks(userId) {
    const result = await pool.query(
      `SELECT id, title, description, due_date
       FROM tasks
       WHERE user_id = $1
         AND is_completed = FALSE
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Normalize a string for fuzzy comparison
   */
  function normalize(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Compute simple local confidence score (pre-AI quick filter)
   * Returns 0.0 – 1.0 based on word overlap
   */
  function localConfidence(journalText, taskTitle) {
    const jWords = new Set(normalize(journalText).split(' ').filter(w => w.length > 3));
    const tWords = normalize(taskTitle).split(' ').filter(w => w.length > 3);
    if (tWords.length === 0 || jWords.size === 0) return 0;
    const hits = tWords.filter(w => jWords.has(w)).length;
    return hits / tWords.length;
  }

  /**
   * Build AI matching prompt and call the LLM.
   * Returns array of matches with AI-assigned confidence, match_type, etc.
   */
  async function runAIMatching(journalContent, activeTasks) {
    const taskList = activeTasks.length > 0
      ? activeTasks.map((t, i) =>
          `${i}: [id=${t.id}] "${t.title}"${t.description ? ` (${t.description.slice(0, 80)})` : ''}`
        ).join('\n')
      : '(no active tasks)';

    const systemPrompt = `You are an AI assistant that reads a user's daily journal entry and matches it to tasks they have active in their task list. You also identify NEW tasks the user mentions that don't match any existing task.

Your job:
1. Extract mentions of activities, tasks, or accomplishments from the journal entry.
2. Match each mention to the most relevant active task using semantic similarity.
3. Determine if the match means the task was FULLY completed, PARTIALLY done, or is a NEW task to create.
4. For partial completions, extract a short progress note.
5. For "called X but need to call back" patterns, mark match_type=complete AND add followup_task_title.
6. Assign a confidence score 0.0–1.0 for each match (be conservative — false positives are worse than misses).
7. For any actionable item mentioned that does NOT match an existing task, add it to "new_task_suggestions" with a clear title and optional due date/time.

Return ONLY valid JSON:
{
  "matches": [
    {
      "task_id": 123,
      "confidence": 0.92,
      "matched_phrase": "exact phrase from journal entry",
      "match_type": "complete",
      "progress_note": null,
      "followup_task_title": null
    }
  ],
  "new_task_suggestions": [
    {
      "title": "Fix Golda's towel hook",
      "matched_phrase": "still need to fix Golda's towel hook",
      "due_date": null,
      "due_time": null
    },
    {
      "title": "Contact lawn rental company about pickup date",
      "matched_phrase": "need to contact lawn rental company about changing pickup date",
      "due_date": null,
      "due_time": null
    }
  ],
  "partial_note": "Overall note if user mentioned starting but not finishing something without a task match",
  "expense_mentions": [
    { "amount": 40.00, "description": "groceries", "category": "Food" }
  ]
}

Rules for matches:
- confidence ≥ 0.85: strong match, user likely did this task
- confidence 0.60–0.84: possible match, show as suggestion
- confidence < 0.60: omit from output
- match_type options: "complete" | "partial" | "create"
- Only use match_type "create" if the journal mentions something with NO matching active task
- Be conservative: when in doubt, lower the confidence or omit
- partial_note: only set if user clearly said they started something but didn't finish

Rules for new_task_suggestions:
- Only suggest tasks for actionable items NOT matched to an existing task
- Write clear, concise task titles (imperative form: "Fix X", "Call Y", "Review Z")
- If a time is mentioned (e.g., "at 845", "by 3pm", "tomorrow morning"), extract it as due_time (24h format HH:MM) and/or due_date (YYYY-MM-DD)
- Don't suggest tasks for things the user already completed (past tense)
- Don't suggest vague non-actionable items`;

    const userPrompt = `Journal entry:
"""
${journalContent}
"""

Active tasks:
${taskList}

Analyze the journal and return the JSON response.`;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('ai_timeout')), AI_TIMEOUT_MS)
    );

    let raw = '';
    try {
      raw = await Promise.race([
        complete({
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 1500,
        }),
        timeoutPromise
      ]);

      // Strip markdown code fences if the model wraps JSON in ```json ... ```
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json|JSON)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(raw);

      return {
        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
        new_task_suggestions: Array.isArray(parsed.new_task_suggestions) ? parsed.new_task_suggestions : [],
        partial_note: parsed.partial_note || null,
        expense_mentions: Array.isArray(parsed.expense_mentions) ? parsed.expense_mentions : []
      };
    } catch (err) {
      if (err.message === 'ai_timeout') {
        return { matches: [], new_task_suggestions: [], partial_note: null, expense_mentions: [], error: 'timeout' };
      }
      console.error('[journal] AI matching error:', err.message, '| raw response start:', raw.slice(0, 200));
      return { matches: [], new_task_suggestions: [], partial_note: null, expense_mentions: [], error: 'ai_error' };
    }
  }

  /**
   * Upsert trust metrics for user+date
   */
  async function bumpTrustMetric(userId, field, count = 1) {
    await pool.query(
      `INSERT INTO journal_trust_metrics (user_id, metric_date, ${field})
       VALUES ($1, CURRENT_DATE, $2)
       ON CONFLICT (user_id, metric_date)
       DO UPDATE SET ${field} = journal_trust_metrics.${field} + $2,
                     updated_at = NOW()`,
      [userId, count]
    );
  }

  // ─────────────────────────────────────────────────────────────
  // POST /api/journal — Submit new journal entry
  // ─────────────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const { content, entry_type = 'evening' } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length < 5) {
        return res.status(400).json({ success: false, message: 'Journal entry is too short.' });
      }
      if (!['morning', 'evening'].includes(entry_type)) {
        return res.status(400).json({ success: false, message: 'entry_type must be morning or evening.' });
      }

      const trimmed = content.trim();

      // 1. Insert journal entry
      const entryResult = await pool.query(
        `INSERT INTO journal_entries (user_id, content, entry_type)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, trimmed, entry_type]
      );
      const entry = entryResult.rows[0];

      // 2. Get active tasks for matching
      const activeTasks = await getActiveTasks(userId);

      // 3. Quick local pre-filter — skip tasks with zero word overlap (saves AI calls)
      const candidates = activeTasks.filter(t => localConfidence(trimmed, t.title) > 0);

      // 4. Run AI matching (always sends full task list if candidates are empty, or all tasks for new task detection)
      const { matches: aiMatches, new_task_suggestions: aiNewTasks, partial_note, expense_mentions } = await runAIMatching(trimmed, candidates.length > 0 ? candidates : activeTasks);

      // 5. Filter matches by confidence threshold + validate task_id belongs to user
      const validTaskIds = new Set(activeTasks.map(t => t.id));
      const validMatches = aiMatches.filter(m =>
        m.confidence >= CONFIDENCE_MED &&
        m.task_id &&
        validTaskIds.has(m.task_id)
      );

      // 6. Save matches to DB
      const savedMatches = [];
      for (const match of validMatches) {
        const mr = await pool.query(
          `INSERT INTO journal_matches
           (journal_entry_id, task_id, user_id, confidence, matched_phrase, match_type, progress_note, followup_task_title)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            entry.id,
            match.task_id,
            userId,
            Math.min(1, Math.max(0, parseFloat(match.confidence) || 0)),
            match.matched_phrase || null,
            match.match_type || 'complete',
            match.progress_note || null,
            match.followup_task_title || null
          ]
        );
        // Enrich match with task title for response
        const task = activeTasks.find(t => t.id === match.task_id);
        savedMatches.push({ ...mr.rows[0], task_title: task?.title });
      }

      // 7. Update entry with AI processing metadata
      await pool.query(
        `UPDATE journal_entries SET ai_processed_at = NOW(), partial_note = $2 WHERE id = $1`,
        [entry.id, partial_note || null]
      );

      // 8. Update trust metrics: suggestions_shown
      if (savedMatches.length > 0) {
        await bumpTrustMetric(userId, 'suggestions_shown', savedMatches.length);
      }

      // 9. Auto-log expenses mentioned (if any) — best-effort, non-blocking
      if (expense_mentions && expense_mentions.length > 0) {
        for (const exp of expense_mentions) {
          if (exp.amount > 0) {
            pool.query(
              `INSERT INTO expenses (user_id, amount, category, description, source, created_at)
               VALUES ($1, $2, $3, $4, 'journal', NOW())`,
              [userId, exp.amount, exp.category || 'Other', exp.description || '']
            ).catch(() => {}); // fire-and-forget; don't block the response
          }
        }
      }

      res.json({
        success: true,
        entry: {
          ...entry,
          ai_processed_at: new Date().toISOString(),
          partial_note: partial_note || null
        },
        matches: savedMatches,
        new_task_suggestions: (aiNewTasks || []).map(s => ({
          title: s.title,
          matched_phrase: s.matched_phrase || null,
          due_date: s.due_date || null,
          due_time: s.due_time || null
        })),
        expense_mentions: expense_mentions || []
      });
    } catch (err) {
      console.error('[journal] POST error:', err);
      res.status(500).json({ success: false, message: 'Failed to save journal entry.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/journal — List past entries
  // ─────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.id;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = parseInt(req.query.offset) || 0;

      const result = await pool.query(
        `SELECT je.*,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', jm.id,
                 'task_id', jm.task_id,
                 'task_title', t.title,
                 'confidence', jm.confidence,
                 'match_type', jm.match_type,
                 'user_approved', jm.user_approved,
                 'task_completed', jm.task_completed,
                 'completion_undone', jm.completion_undone,
                 'matched_phrase', jm.matched_phrase
               ) ORDER BY jm.confidence DESC
             ) FILTER (WHERE jm.id IS NOT NULL),
             '[]'
           ) as matches
         FROM journal_entries je
         LEFT JOIN journal_matches jm ON jm.journal_entry_id = je.id
         LEFT JOIN tasks t ON t.id = jm.task_id
         WHERE je.user_id = $1
         GROUP BY je.id
         ORDER BY je.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      res.json({ success: true, entries: result.rows });
    } catch (err) {
      console.error('[journal] GET list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load journal entries.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/journal/:id — Single entry with matches
  // ─────────────────────────────────────────────────────────────
  router.get('/:id', async (req, res) => {
    try {
      const userId = req.user.id;
      const entryId = parseInt(req.params.id);

      const entryResult = await pool.query(
        `SELECT * FROM journal_entries WHERE id = $1 AND user_id = $2`,
        [entryId, userId]
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Entry not found.' });
      }

      const matchesResult = await pool.query(
        `SELECT jm.*, t.title as task_title, t.is_completed as task_is_currently_completed
         FROM journal_matches jm
         JOIN tasks t ON t.id = jm.task_id
         WHERE jm.journal_entry_id = $1 AND jm.user_id = $2
         ORDER BY jm.confidence DESC`,
        [entryId, userId]
      );

      res.json({
        success: true,
        entry: entryResult.rows[0],
        matches: matchesResult.rows
      });
    } catch (err) {
      console.error('[journal] GET single error:', err);
      res.status(500).json({ success: false, message: 'Failed to load entry.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/journal/:id/matches/:matchId/approve — Approve single match
  // ─────────────────────────────────────────────────────────────
  router.post('/:id/matches/:matchId/approve', async (req, res) => {
    const client = await pool.connect();
    try {
      const userId = req.user.id;
      const entryId = parseInt(req.params.id);
      const matchId = parseInt(req.params.matchId);

      await client.query('BEGIN');

      // Verify ownership
      const matchResult = await client.query(
        `SELECT jm.*, je.user_id as entry_user_id
         FROM journal_matches jm
         JOIN journal_entries je ON je.id = jm.journal_entry_id
         WHERE jm.id = $1 AND jm.journal_entry_id = $2 AND jm.user_id = $3`,
        [matchId, entryId, userId]
      );
      if (matchResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Match not found.' });
      }

      const match = matchResult.rows[0];

      // Mark match as approved
      await client.query(
        `UPDATE journal_matches SET user_approved = TRUE, approved_at = NOW() WHERE id = $1`,
        [matchId]
      );

      let taskCompleted = false;
      let followupCreated = null;

      if (match.match_type === 'complete') {
        // Auto-complete the task
        await client.query(
          `UPDATE tasks SET is_completed = TRUE, completed_at = NOW() WHERE id = $1 AND user_id = $2`,
          [match.task_id, userId]
        );
        await client.query(
          `UPDATE journal_matches SET task_completed = TRUE, task_completed_at = NOW() WHERE id = $1`,
          [matchId]
        );
        taskCompleted = true;

        // Create follow-up task if specified
        if (match.followup_task_title) {
          const followup = await client.query(
            `INSERT INTO tasks (user_id, title, created_at)
             VALUES ($1, $2, NOW())
             RETURNING id, title`,
            [userId, match.followup_task_title]
          );
          followupCreated = followup.rows[0];
        }
      } else if (match.match_type === 'partial' && match.progress_note) {
        // Log progress note — add a step or update description as note
        // For now: we'll add to task description as a progress note
        await client.query(
          `UPDATE tasks
           SET description = COALESCE(description, '') ||
             CASE WHEN description IS NOT NULL AND description != '' THEN E'\n' ELSE '' END ||
             '[Progress ' || TO_CHAR(NOW(), 'Mon DD') || '] ' || $2
           WHERE id = $1 AND user_id = $3`,
          [match.task_id, match.progress_note, userId]
        );
      }

      await client.query('COMMIT');

      // Trust metric
      await bumpTrustMetric(userId, 'suggestions_approved');

      res.json({
        success: true,
        task_completed: taskCompleted,
        followup_created: followupCreated
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[journal] approve match error:', err);
      res.status(500).json({ success: false, message: 'Failed to approve match.' });
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/journal/:id/matches/:matchId/dismiss — Dismiss single match
  // ─────────────────────────────────────────────────────────────
  router.post('/:id/matches/:matchId/dismiss', async (req, res) => {
    try {
      const userId = req.user.id;
      const matchId = parseInt(req.params.matchId);
      const entryId = parseInt(req.params.id);

      const result = await pool.query(
        `UPDATE journal_matches
         SET user_approved = FALSE, dismissed_at = NOW()
         WHERE id = $1 AND journal_entry_id = $2 AND user_id = $3
         RETURNING id`,
        [matchId, entryId, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Match not found.' });
      }

      await bumpTrustMetric(userId, 'suggestions_dismissed');

      res.json({ success: true });
    } catch (err) {
      console.error('[journal] dismiss match error:', err);
      res.status(500).json({ success: false, message: 'Failed to dismiss match.' });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/journal/:id/matches/:matchId/undo — Undo task completion
  // ─────────────────────────────────────────────────────────────
  router.post('/:id/matches/:matchId/undo', async (req, res) => {
    const client = await pool.connect();
    try {
      const userId = req.user.id;
      const matchId = parseInt(req.params.matchId);
      const entryId = parseInt(req.params.id);

      await client.query('BEGIN');

      const matchResult = await client.query(
        `SELECT * FROM journal_matches WHERE id = $1 AND journal_entry_id = $2 AND user_id = $3`,
        [matchId, entryId, userId]
      );
      if (matchResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Match not found.' });
      }

      const match = matchResult.rows[0];
      if (!match.task_completed) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Task was not completed by journal.' });
      }

      // Undo task completion
      await client.query(
        `UPDATE tasks SET is_completed = FALSE, completed_at = NULL WHERE id = $1 AND user_id = $2`,
        [match.task_id, userId]
      );

      // Mark match as undone
      await client.query(
        `UPDATE journal_matches
         SET completion_undone = TRUE, completion_undone_at = NOW()
         WHERE id = $1`,
        [matchId]
      );

      await client.query('COMMIT');

      // Trust metric
      await bumpTrustMetric(userId, 'completions_undone');

      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[journal] undo error:', err);
      res.status(500).json({ success: false, message: 'Failed to undo completion.' });
    } finally {
      client.release();
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/journal/create-task — Create a new task from journal suggestion
  // ─────────────────────────────────────────────────────────────
  router.post('/create-task', async (req, res) => {
    try {
      const userId = req.user.id;
      const { title, due_date, due_time, entry_id: _entryId } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Task title is required.' });
      }

      // Build due_date with optional time
      let taskDueDate = null;
      if (due_date) {
        taskDueDate = due_date;
        if (due_time) {
          // Combine date and time: "2026-04-28" + "08:45" → "2026-04-28T08:45:00"
          taskDueDate = `${due_date}T${due_time}:00`;
        }
      } else if (due_time) {
        // Time without date → assume today
        const today = new Date().toISOString().split('T')[0];
        taskDueDate = `${today}T${due_time}:00`;
      }

      const result = await pool.query(
        `INSERT INTO tasks (user_id, title, due_date, source, created_at)
         VALUES ($1, $2, $3, 'journal', NOW())
         RETURNING id, title, due_date, created_at`,
        [userId, title.trim(), taskDueDate]
      );

      const task = result.rows[0];

      // Auto-tag the new task (best-effort, non-blocking)
      try {
        const autoTagger = require('../lib/auto-tagger');
        if (autoTagger && autoTagger.matchTaskToValue) {
          autoTagger.matchTaskToValue(pool, userId, task.title).catch(() => {});
        }
      } catch (_) { /* auto-tagger not available, skip */ }

      res.json({
        success: true,
        task: task
      });
    } catch (err) {
      console.error('[journal] create-task error:', err);
      res.status(500).json({ success: false, message: 'Failed to create task.' });
    }
  });

  return router;
};
