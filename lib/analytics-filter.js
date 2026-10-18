'use strict';
/**
 * Which analytics requests are people, and which are bots or our own CI.
 *
 * classifyTraffic(headers) → null for a real visitor, or the reason it's
 * filtered: 'missing_ua' | 'bot_ua' | 'ci'. Filtered requests are not written
 * to analytics_events / visitor_sessions; routes/analytics.js counts them per
 * day and reason in analytics_filtered_daily so the admin can see real vs
 * filtered.
 *
 * CI marker: our own automation (Playwright smoke + e2e configs,
 * scripts/prod-signup-check.js) sends the X-FL-Automation header and/or a
 * "FocusLedger-" user-agent token. The client library also stays silent when
 * navigator.webdriver is set (#222); this is the server-side backstop for
 * anything that skips or spoofs that.
 */

const CI_HEADER = 'x-fl-automation';
const CI_UA_RE = /FocusLedger-(ci|smoke|e2e|signup-monitor)/i;

const BOT_PATTERNS = [
  /bot/i, /crawl/i, /spider/i, /slurp/i, /fetch/i, /scan/i,
  /headless/i, /phantom/i, /puppeteer/i, /playwright/i, /selenium/i, /webdriver/i,
  /python/i, /go-http/i, /curl/i, /wget/i, /libwww/i, /httpie/i, /postman/i,
  /yandex/i, /duckduck/i, /baidu/i, /semrush/i, /ahrefs/i, /rogerbot/i,
  /ia_archiver/i, /facebookexternalhit/i, /facebookcatalog/i, /meta-externalagent/i,
  /whatsapp/i, /telegram/i, /dataprovider/i, /screaming.frog/i, /sistrix/i, /archive\.org/i,
  /axios/i, /node-fetch/i, /undici/i, /okhttp/i, /scrapy/i, /java\//i, /httpclient/i,
  /pingdom/i, /uptime/i, /statuscake/i, /site24x7/i, /monitor/i,
  /lighthouse/i, /pagespeed/i, /gtmetrix/i, /prerender/i, /preview/i,
  /google-inspectiontool/i, /mediapartners-google/i, /google-extended/i,
  /gptbot/i, /claudebot/i, /ccbot/i, /bytespider/i, /petalbot/i, /amazonbot/i,
  /anthropic/i, /perplexity/i, /cohere-ai/i, /diffbot/i, /electron/i,
];

/** True for a user agent that isn't an ordinary browser. */
function isBotUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return true;
  // Every mainstream browser UA starts with "Mozilla/"; scripts and SDKs don't.
  if (!/^Mozilla\//.test(ua.trim())) return true;
  return BOT_PATTERNS.some(p => p.test(ua));
}

/**
 * @param {object} headers Express req.headers (lower-cased keys)
 * @returns {null|'missing_ua'|'bot_ua'|'ci'}
 */
function classifyTraffic(headers = {}) {
  const ua = headers['user-agent'] || '';
  if (headers[CI_HEADER] || CI_UA_RE.test(ua)) return 'ci';
  if (!ua.trim()) return 'missing_ua';
  if (isBotUserAgent(ua)) return 'bot_ua';
  return null;
}

module.exports = { classifyTraffic, isBotUserAgent, CI_HEADER };
