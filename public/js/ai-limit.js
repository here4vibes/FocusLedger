/**
 * ai-limit.js — one place the frontends turn the server's "daily AI limit"
 * answer (HTTP 429, code AI_DAILY_LIMIT, from lib/ai-budget.js) into words.
 *
 *   if (FLAiLimit.is(data)) show(FLAiLimit.text(data));
 *
 * The server's `message` is complete on its own. The `upsell` line (Free plan
 * only) is added here and only on the web: inside the native iOS app we must
 * not point at a web purchase, and only the client can tell it's in that app.
 */
(function (global) {
  'use strict';

  function isNativeIOS() {
    try {
      return !!(global.Capacitor
        && global.Capacitor.isNativePlatform && global.Capacitor.isNativePlatform()
        && global.Capacitor.getPlatform && global.Capacitor.getPlatform() === 'ios');
    } catch (e) {
      console.warn('[ai-limit] platform check failed, leaving the upgrade line out:', e && e.message);
      return true;
    }
  }

  function is(data) {
    return !!data && data.code === 'AI_DAILY_LIMIT';
  }

  function text(data) {
    var msg = (data && data.message) || "You've used today's AI help. Everything else still works.";
    if (data && data.upsell && !isNativeIOS()) msg += ' ' + data.upsell;
    return msg;
  }

  global.FLAiLimit = { is: is, text: text, isNativeIOS: isNativeIOS };
})(typeof window !== 'undefined' ? window : this);
