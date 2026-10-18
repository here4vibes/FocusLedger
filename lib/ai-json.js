'use strict';
/**
 * Parse JSON out of a model reply. Models often wrap JSON in ```json fences or
 * add a sentence around it even when told not to; JSON.parse on the raw text
 * then throws (Sentry NODE-EXPRESS-D: every AI duration estimate failed).
 *
 * Tries, in order: the text as-is, the text with code fences removed, and the
 * first {...} or [...] block in it. Throws if none parses.
 * @param {string} raw
 * @returns {*}
 */
function parseAiJson(raw) {
  if (typeof raw !== 'string') throw new Error('AI reply was not text');
  const text = raw.trim();
  const attempts = [
    text,
    text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim(),
  ];
  const block = text.match(/[{[][\s\S]*[}\]]/);
  if (block) attempts.push(block[0]);
  let lastErr;
  for (const candidate of attempts) {
    try { return JSON.parse(candidate); } catch (e) { lastErr = e; } // silent-ok: tries the next candidate, throws the last error
  }
  throw lastErr;
}

module.exports = { parseAiJson };
