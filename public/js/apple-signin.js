/**
 * apple-signin.js — the "Sign in with Apple" button for the login and signup pages.
 *
 * FLAppleSignIn.mount({ before: <element>, mode: 'login' | 'signup' })
 *   Asks GET /api/auth/apple/config; when the server has Apple configured it
 *   inserts the button before the given element. Not configured → nothing is
 *   rendered. A tap is a plain navigation to /api/auth/apple/start, which
 *   redirects to Apple; Apple posts back to the server, which returns here
 *   with ?apple_token=… (or ?apple_error=…).
 *
 * FLAppleSignIn.errorMessage(code) — copy for an ?apple_error= code.
 *
 * Button style follows Apple's guidelines: black, white Apple logo, system
 * font, "Sign in with Apple" / "Sign up with Apple", same size as the other
 * sign-in buttons and placed first.
 */
(function (global) {
  'use strict';

  var LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">'
    + '<path fill="#fff" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>'
    + '</svg>';

  var CSS = '.btn-apple{width:100%;display:flex;align-items:center;justify-content:center;gap:0.5rem;'
    + 'min-height:48px;padding:0.8rem 1rem;background:#000;color:#fff;border:1.5px solid #000;border-radius:12px;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;'
    + 'font-size:1rem;font-weight:500;cursor:pointer;margin-bottom:0.5rem;}'
    + '.btn-apple:active{transform:scale(0.98);}'
    + '.btn-apple:disabled{opacity:0.7;cursor:default;}'
    + '.btn-apple svg{flex-shrink:0;margin-top:-2px;}';

  var ERRORS = {
    access_denied: 'Sign-in was cancelled. You can try again or use your email and password.',
    invalid_state: 'That sign-in attempt expired. Please try again.',
    invalid_callback: 'Something went wrong with Apple. Please try again.',
    verification_failed: 'We couldn’t verify your Apple sign-in. Please try again.',
    no_email: 'Apple didn’t share an email address, so we couldn’t create your account. Please try again or sign up with email.',
    email_unverified: 'Apple hasn’t verified that email address yet. Verify it with Apple, or sign up with email.',
    email_taken: 'That email already belongs to an account linked to a different Apple ID. Log in with your email and password.',
    server_error: 'Server error. Please try again in a moment.'
  };

  function errorMessage(code) {
    return ERRORS[code] || 'Sign in with Apple failed. Please try again or use your email and password.';
  }

  function render(before, mode) {
    if (!before || !before.parentNode || document.getElementById('appleBtn')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'appleBtn';
    btn.className = 'btn-apple';
    btn.innerHTML = LOGO + '<span>' + (mode === 'signup' ? 'Sign up with Apple' : 'Sign in with Apple') + '</span>';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      global.location.href = '/api/auth/apple/start?return_to=' + (mode === 'signup' ? 'signup' : 'login');
    });
    before.parentNode.insertBefore(btn, before);
  }

  function mount(opts) {
    opts = opts || {};
    return fetch('/api/auth/apple/config')
      .then(function (r) { return r.ok ? r.json() : { enabled: false }; })
      .then(function (cfg) {
        if (cfg && cfg.enabled) render(opts.before, opts.mode);
        return !!(cfg && cfg.enabled);
      })
      .catch(function (e) {
        console.warn('[apple-signin] config check failed; button not shown:', e && e.message);
        return false;
      });
  }

  global.FLAppleSignIn = { mount: mount, errorMessage: errorMessage };
})(window);
