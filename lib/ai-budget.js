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
 * The day is the UTC day, so the limit resets at midnight UTC; the message
 * says that in the user's own clock (resetPhrase).
 *
 * Limits: AI_DAILY_LIMIT_FREE (default 100), AI_DAILY_LIMIT_PRO (default 500).
 * Each Buddy message runs up to 3 calls (reply, completion detection, passive
 * capture), so a free day allows roughly 30 messages; real use sits well below.
 */
const { getContext } = require('./request-context');
const aiUsage = require('../db/ai-usage');
const { checkProStatus } = require('../middleware/proUtils');
const { fetchUserTimezone } = require('./timezone');

function limitFor(tier) {
  const raw = tier === 'pro' ? process.env.AI_DAILY_LIMIT_PRO : process.env.AI_DAILY_LIMIT_FREE;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : (tier === 'pro' ? 500 : 100);
}

/** The budget day is the UTC day (db/ai-usage.js), so it resets at the next UTC midnight. */
function nextResetAt(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * When the budget resets, said in the user's own clock: "7 PM your time",
 * "5:30 AM your time", "midnight your time". Without a usable timezone it
 * says "midnight UTC", which is always true.
 */
function resetPhrase(tz, now = new Date()) {
  if (!tz) return 'midnight UTC';
  try {
    const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
      .format(nextResetAt(now))
      .replace(/\u202f/g, ' ')
      .replace(':00', '');
    if (local === '12 AM') return 'midnight your time';
    if (local === '12 PM') return 'noon your time';
    return `${local} your time`;
  } catch (e) {
    console.warn('[ai-budget] unusable timezone, saying UTC:', e.message, '| tz:', tz);
    return 'midnight UTC';
  }
}

class AiQuotaError extends Error {
  /**
   * @param {'free'|'pro'} tier
   * @param {number} limit
   * @param {string} [tz] the user's IANA timezone, for the reset time
   */
  constructor(tier, limit, tz) {
    super(`daily AI limit reached (${tier}: ${limit})`);
    this.code = 'AI_DAILY_LIMIT';
    this.status = 429;
    this.tier = tier;
    this.limit = limit;
    this.resetsAt = nextResetAt().toISOString();
    this.userMessage = `You've used today's AI help. It resets at ${resetPhrase(tz)}, and everything else still works.`;
    // Shown by the web frontends only (public/js/ai-limit.js): the native iOS
    // app must not point at a web purchase, and the server can't tell the two
    // apart (the Capacitor shell sends no User-Agent token).
    this.upsell = tier === 'pro' ? null : 'Autopilot raises the daily limit.';
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
    // Never throws: falls back to the app-wide default zone and logs.
    const tz = await fetchUserTimezone(ctx.pool, userId);
    const err = new AiQuotaError(ctx.aiTier, limit, tz);
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

/** The one response body for "over today's AI limit" (HTTP 429). */
function aiLimitBody(err) {
  return {
    success: false,
    code: err.code,
    message: err.userMessage,
    upsell: err.upsell || null,
    limit: err.limit,
    tier: err.tier,
    resets_at: err.resetsAt || null,
  };
}

/** Answer 429 with the daily-limit body. */
function sendAiLimit(res, err) {
  return res.status(429).json(aiLimitBody(err));
}

/**
 * The AiQuotaError this request ran into, if any. For routes whose AI helper
 * swallows errors and returns a fallback (lib/taskParsingService.js,
 * lib/ai-service.js): check this before answering with the fallback.
 */
function quotaHit() {
  const ctx = getContext();
  return (ctx && ctx.aiQuotaError) || null;
}

/**
 * Express middleware: if this request hit the AI limit and the route answered
 * with a generic 5xx (most AI routes catch errors and return 500), answer 429
 * with a clear message instead. A route that catches the AI error and answers
 * 200 itself must test isQuotaError(err) / quotaHit() and call sendAiLimit, or
 * the user never learns why the AI went quiet.
 */
function quotaAwareResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    const ctx = getContext();
    if (ctx && ctx.aiQuotaError && res.statusCode >= 500) {
      res.status(429);
      return json(aiLimitBody(ctx.aiQuotaError));
    }
    return json(body);
  };
  next();
}

function isQuotaError(err) {
  return !!err && err.code === 'AI_DAILY_LIMIT';
}

module.exports = {
  reserve, recordUsage, isQuotaError, quotaAwareResponses, AiQuotaError, limitFor,
  aiLimitBody, sendAiLimit, quotaHit, resetPhrase, nextResetAt,
};
