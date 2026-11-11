/**
 * in-app-browser.js — is this page open inside an app's built-in browser?
 *
 * Ads open in the Facebook / Instagram (and TikTok, LinkedIn, Snapchat…)
 * in-app browser. Google refuses OAuth sign-in from those embedded webviews
 * ("disallowed_useragent"), so "Sign up with Google" is a dead end there.
 * The landing, signup and login pages use this to lead with email instead.
 *
 * Browser: window.FLInApp.isInApp([ua]).  Node (jest): require() it.
 */
(function (root) {
  'use strict';

  // Tokens these apps add to the user agent of their built-in browser.
  var IN_APP_UA = /\b(FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|BytedanceWebview|LinkedInApp|Pinterest|Twitter(?:Android| for iPhone))/i;

  function isInApp(ua) {
    if (ua == null) ua = (root.navigator && root.navigator.userAgent) || '';
    return IN_APP_UA.test(String(ua));
  }

  var api = { isInApp: isInApp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FLInApp = api;
})(typeof window !== 'undefined' ? window : globalThis);
