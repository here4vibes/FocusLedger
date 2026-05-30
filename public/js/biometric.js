/**
 * biometric.js — Face ID / Touch ID authentication for iOS Capacitor shell
 * Owns: biometric prompt, credential storage in iOS Keychain, opt-in flow
 * Does NOT own: auth tokens, login API calls, session management, routing
 *
 * Credentials are stored in iOS Keychain via the NativeBiometric plugin.
 * NEVER stored in localStorage or plain text. The plugin handles secure storage.
 *
 * No-op when running outside the Capacitor native context (browser/PWA).
 * Callers check FLBiometric.isAvailable() before prompting.
 */

(function(window) {
  'use strict';

  var KEYCHAIN_SERVER = 'focusledger.net';
  var PREF_KEY = 'fl_biometric_enabled';

  // Detect Capacitor native environment
  function isNative() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  }

  // Get the NativeBiometric plugin — null in browser context
  function getPlugin() {
    if (!isNative()) return null;
    try {
      var plugins = window.Capacitor && window.Capacitor.Plugins;
      return (plugins && plugins.NativeBiometric) ? plugins.NativeBiometric : null;
    } catch(e) {
      return null;
    }
  }

  /**
   * Check if biometric auth is available on this device.
   * Returns a Promise<boolean>.
   */
  function isAvailable() {
    var plugin = getPlugin();
    if (!plugin) return Promise.resolve(false);
    return plugin.isAvailable()
      .then(function(result) { return result && result.isAvailable === true; })
      .catch(function() { return false; });
  }

  /**
   * Check if user has opted in to biometric login.
   * Fast synchronous check — stored in localStorage as a convenience flag.
   * The flag alone does NOT grant access; it only controls whether to attempt auth.
   */
  function isEnabled() {
    try {
      return localStorage.getItem(PREF_KEY) === 'true';
    } catch(e) {
      return false;
    }
  }

  /**
   * Enable biometric login. Stores credentials securely in iOS Keychain.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<boolean>} true if successfully enrolled
   */
  function enable(email, password) {
    var plugin = getPlugin();
    if (!plugin) return Promise.resolve(false);
    return plugin.setCredentials({
      username: email,
      password: password,
      server: KEYCHAIN_SERVER
    })
    .then(function() {
      try { localStorage.setItem(PREF_KEY, 'true'); } catch(e) {}
      return true;
    })
    .catch(function() { return false; });
  }

  /**
   * Disable biometric login. Removes credentials from Keychain and clears the flag.
   * @returns {Promise<boolean>}
   */
  function disable() {
    try { localStorage.removeItem(PREF_KEY); } catch(e) {}
    var plugin = getPlugin();
    if (!plugin) return Promise.resolve(true);
    return plugin.deleteCredentials({ server: KEYCHAIN_SERVER })
      .then(function() { return true; })
      .catch(function() { return true; }); // credential may not exist; that's fine
  }

  /**
   * Prompt for biometric auth and retrieve stored credentials.
   * @param {string} reason - message shown in the Face ID / Touch ID dialog
   * @returns {Promise<{email: string, password: string}|null>}
   *   null if auth failed, cancelled, or credentials not found
   */
  function authenticate(reason) {
    var plugin = getPlugin();
    if (!plugin) return Promise.resolve(null);
    return plugin.verifyIdentity({
      reason: reason || 'Log in to FocusLedger',
      title: 'FocusLedger',
      description: 'Use Face ID or Touch ID to access your account',
      negativeButtonText: 'Use Password'
    })
    .then(function(verified) {
      if (!verified || !verified.isVerified) return null;
      return plugin.getCredentials({ server: KEYCHAIN_SERVER });
    })
    .then(function(creds) {
      if (!creds || !creds.username) return null;
      return { email: creds.username, password: creds.password };
    })
    .catch(function() { return null; });
  }

  /**
   * Attempt biometric auto-login on app open.
   * Calls loginFn(email, password) — the caller's existing login handler.
   * @param {function(string, string): Promise} loginFn
   * @returns {Promise<boolean>} true if biometric login succeeded
   */
  function tryAutoLogin(loginFn) {
    if (!isEnabled()) return Promise.resolve(false);
    return isAvailable()
      .then(function(available) {
        if (!available) return false;
        return authenticate('Log in to FocusLedger');
      })
      .then(function(creds) {
        if (!creds) return false;
        return loginFn(creds.email, creds.password);
      })
      .catch(function() { return false; });
  }

  /**
   * Show the opt-in prompt after a successful first login.
   * Appends a modal to document.body asking if user wants Face ID.
   * @param {string} email
   * @param {string} password
   * @param {function(boolean)} callback - called with true if user accepted
   */
  function showOptInPrompt(email, password, callback) {
    // Only show in native context with biometric available
    isAvailable().then(function(available) {
      if (!available) { callback(false); return; }

      var overlay = document.createElement('div');
      overlay.id = 'fl-biometric-prompt';
      overlay.style.cssText = [
        'position:fixed;top:0;left:0;right:0;bottom:0',
        'background:rgba(1,30,92,0.7)',
        'z-index:9999',
        'display:flex;align-items:center;justify-content:center',
        'padding:1.5rem',
        'font-family:"DM Sans",sans-serif'
      ].join(';');

      var card = document.createElement('div');
      card.style.cssText = [
        'background:#fff',
        'border-radius:20px',
        'padding:2rem 1.75rem',
        'max-width:340px;width:100%',
        'text-align:center',
        'box-shadow:0 24px 60px rgba(0,0,0,0.2)'
      ].join(';');

      card.innerHTML = [
        '<div style="font-size:2.5rem;margin-bottom:1rem">🔐</div>',
        '<h2 style="font-family:\'Space Grotesk\',sans-serif;font-size:1.3rem;color:#011e5c;margin-bottom:0.5rem">',
        'Enable Face ID?</h2>',
        '<p style="font-size:0.88rem;color:#6b6b6b;line-height:1.5;margin-bottom:1.75rem">',
        'Log in instantly without typing your password every time.<br>',
        'Your credentials stay private in iOS Keychain.</p>',
        '<button id="fl-bio-yes" style="',
        'width:100%;padding:0.85rem;background:#c9a84c;color:#fff;border:none;',
        'border-radius:12px;font-size:1rem;font-weight:600;font-family:\'DM Sans\',sans-serif;',
        'cursor:pointer;margin-bottom:0.75rem;">Enable Face ID</button>',
        '<button id="fl-bio-no" style="',
        'width:100%;padding:0.75rem;background:none;color:#6b6b6b;border:none;',
        'font-size:0.875rem;font-family:\'DM Sans\',sans-serif;cursor:pointer;">',
        'Not right now</button>'
      ].join('');

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function cleanup() {
        try { document.body.removeChild(overlay); } catch(e) {}
      }

      document.getElementById('fl-bio-yes').addEventListener('click', function() {
        cleanup();
        enable(email, password).then(function(ok) {
          callback(ok);
        });
      });

      document.getElementById('fl-bio-no').addEventListener('click', function() {
        cleanup();
        callback(false);
      });
    });
  }

  // Expose as FLBiometric global
  window.FLBiometric = {
    isAvailable: isAvailable,
    isEnabled: isEnabled,
    enable: enable,
    disable: disable,
    authenticate: authenticate,
    tryAutoLogin: tryAutoLogin,
    showOptInPrompt: showOptInPrompt
  };

}(window));
