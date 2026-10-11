'use strict';
/**
 * Per-user daily AI budget, enforced in lib/claude-client.js so every AI call
 * counts, whatever route made it.
 *
 * Before: logged-in AI endpoints were only covered by the global 300 requests
 * per 15 min per IP limit, so one heavy (or scripted) free account could run
 * up the model bill without bound. Now each user gets a daily number of AI
 * calls by plan; tokens are recorded for cost visibility. Calls outside a
 * request (cron jobs) aren't capped.
 *
 * Limits: AI_DAILY_LIMIT_FREE (default 100), AI_DAILY_LIMIT_PRO (default 500).
 * Each Buddy message runs up to 3 calls (reply, completion detection, passive
 * capture), so a free day allows roughly 30 messages; real use sits well below.
 */
const { getContext } = require('./request-context');
const aiUsage = require('../db/ai-usage');
const { checkProStatus } = require('../middleware/proUtils');

function limitFor(tier) {
  const raw = tier === 'pro' ? process.env.AI_DAILY_LIMIT_PRO : process.env.AI_DAILY_LIMIT_FREE;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : (tier === 'pro' ? 500 : 100);
}

class AiQuotaError extends Error {
  constructor(tier, limit) {
    super(`daily AI limit reached (${tier}: ${limit})`);
    this.code = 'AI_DAILY_LIMIT';
    this.status = 429;
    this.tier = tier;
    this.limit = limit;
    this.userMessage = tier === 'pro'
      ? "You've hit today's AI limit. It resets at midnight UTC, and everything else still works."
      : "You've used today's free AI help. It resets at midnight UTC, and Autopilot raises the limit.";
  }
}

/**
 * Count this call against the current user's budget.
 * @returns {Promise<{pool, userId}|null>} handle for recordUsage, or null when not in a user request
 * @throws {AiQuotaError} when the user is over today's limit
 */
async function reserve() {
  const ctx = getContext();
  const userId = ctx && ctx.req && ctx.req.user && ctx.req.user.id;
  if (!ctx || !ctx.pool || !userId) return null;

  if (!ctx.aiTier) {
    try {
      ctx.aiTier = (await checkProStatus(ctx.pool, userId)) ? 'pro' : 'free';
    } catch (e) {
      console.error('[ai-budget] plan lookup failed, using free limit:', e.message, '| user:', userId);
      ctx.aiTier = 'free';
    }
  }

  let calls;
  try {
    calls = await aiUsage.incrementAiCalls(ctx.pool, userId);
  } catch (e) {
    // Metering must not take the feature down; fail open, loudly.
    console.error('[ai-budget] usage increment failed (call allowed):', e.message, '| user:', userId);
    return null;
  }
  const limit = limitFor(ctx.aiTier);
  if (calls > limit) {
    if (calls === limit + 1) console.warn('[ai-budget] daily limit reached | user:', userId, '| tier:', ctx.aiTier, '| limit:', limit);
    const err = new AiQuotaError(ctx.aiTier, limit);
    ctx.aiQuotaError = err; // see quotaAwareResponses
    throw err;
  }
  return { pool: ctx.pool, userId };
}

/** Record token usage from an Anthropic response (never throws). */
function recordUsage(handle, usage) {
  if (!handle || !usage) return;
  aiUsage.addAiTokens(handle.pool, handle.userId, usage.input_tokens, usage.output_tokens)
    .catch(e => console.error('[ai-budget] token record failed:', e.message, '| user:', handle.userId));
}

/**
 * Express middleware: if this request hit the AI limit and the route answered
 * with a generic 5xx (most AI routes catch errors and return 500), answer 429
 * with a clear message instead. Routes that handle AI failure themselves
 * (e.g. a canned reply with 200) are left alone.
 */
function quotaAwareResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    const ctx = getContext();
    if (ctx && ctx.aiQuotaError && res.statusCode >= 500) {
      const e = ctx.aiQuotaError;
      res.status(429);
      return json({ success: false, code: e.code, message: e.userMessage, limit: e.limit, tier: e.tier });
    }
    return json(body);
  };
  next();
}

function isQuotaError(err) {
  return !!err && err.code === 'AI_DAILY_LIMIT';
}

module.exports = { reserve, recordUsage, isQuotaError, quotaAwareResponses, AiQuotaError, limitFor };
