/**
 * in-app-browser.js — is this page open inside an app's built-in browser?
 *
 * Ads open in the Facebook / Instagram (and TikTok, LinkedIn, Snapchat…)
 * in-app browser. Google refuses OAuth sign-in from those embedded webviews
 * ("disallowed_useragent"), so "Sign up with Google" is a dead end there.
 * The landing, signup and login pages use this to lead with email instead.
 *
 * Browser: window.FLInApp.isInApp([ua]), .replaceGoogleButton(btn, divider, verb).
 * Node (jest): require() it.
 */
(function (root) {
  'use strict';

  // Tokens these apps add to the user agent of their built-in browser.
  var IN_APP_UA = /\b(FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|musical_ly|BytedanceWebview|LinkedInApp|Pinterest|Twitter(?:Android| for iPhone))/i;

  function isInApp(ua) {
    if (ua == null) ua = (root.navigator && root.navigator.userAgent) || '';
    return IN_APP_UA.test(String(ua));
  }

  // The address to open in a real browser. localStorage doesn't follow the
  // visitor out of the in-app browser, so the first-touch campaign tags
  // (fl_attribution, saved by analytics.js) ride along in the link.
  var CARRY = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  function browserUrl(href, attribution) {
    var hashAt = String(href).indexOf('#');
    var base = hashAt === -1 ? String(href) : String(href).slice(0, hashAt);
    var qAt = base.indexOf('?');
    var query = qAt === -1 ? '' : base.slice(qAt + 1);
    var path = qAt === -1 ? base : base.slice(0, qAt);
    var have = {};
    query.split('&').forEach(function (kv) { if (kv) have[kv.split('=')[0]] = true; });
    var add = [];
    CARRY.forEach(function (k) {
      var v = attribution && attribution[k];
      if (typeof v === 'string' && v && !have[k]) add.push(k + '=' + encodeURIComponent(v.slice(0, 100)));
    });
    var all = [query].concat(add).filter(Boolean).join('&');
    return path + (all ? '?' + all : '');
  }

  // Replace a page's Google button with a short explanation and a "Copy link"
  // button (the one thing that works in every in-app browser). `verb` is
  // "Sign up" or "Log in". Returns the notice, or null when not in-app.
  function replaceGoogleButton(btn, divider, verb) {
    if (!isInApp() || !btn || !btn.parentNode) return null;
    var doc = root.document;
    var attribution = null;
    try { attribution = JSON.parse(root.localStorage.getItem('fl_attribution') || 'null'); }
    catch (e) { console.warn('[in-app] attribution unavailable:', e && e.message); }
    var url = browserUrl(root.location.href, attribution);

    var box = doc.createElement('div');
    box.id = 'inAppNotice';
    box.setAttribute('role', 'note');
    box.style.cssText = 'margin:0 0 14px;font-size:13.5px;line-height:1.45;color:#5c4a12;background:#FFF7E6;border-radius:10px;padding:10px 12px;text-align:left;';
    var msg = doc.createElement('span');
    msg.textContent = verb + ' with email below. Google sign-in is blocked inside this app\u2019s browser; to use Google, open this page in Safari or Chrome. ';
    var copy = doc.createElement('button');
    copy.type = 'button';
    copy.id = 'inAppCopyLink';
    copy.textContent = 'Copy link';
    copy.style.cssText = 'font:inherit;font-weight:600;color:inherit;background:none;border:none;padding:6px 2px;margin:-6px 0;text-decoration:underline;cursor:pointer;';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Link copied \u2713'; };
      var manual = function (e) {
        console.warn('[in-app] clipboard unavailable:', e && e.message);
        root.prompt('Copy this link, then paste it in Safari or Chrome:', url);
      };
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(url).then(done, manual);
      } else manual();
    });
    box.appendChild(msg); box.appendChild(copy);
    btn.parentNode.insertBefore(box, btn);
    btn.style.display = 'none';
    if (divider) divider.style.display = 'none';
    return box;
  }

  var api = { isInApp: isInApp, browserUrl: browserUrl, replaceGoogleButton: replaceGoogleButton };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FLInApp = api;
})(typeof window !== 'undefined' ? window : globalThis);
