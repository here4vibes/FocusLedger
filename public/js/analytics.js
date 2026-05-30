/**
 * FocusLedger Analytics — Shared Client Library
 *
 * Provides privacy-friendly, zero-dependency analytics tracking.
 * Exposes window.FLA (FocusLedger Analytics) with:
 *
 *   FLA.trackPage(page)         — record a page view
 *   FLA.trackEvent(name, data)  — record a named event
 *   FLA.setUser(userId)         — set logged-in user ID for events
 *   FLA.getVisitorId()          — get the anonymous visitor UUID
 *
 * Auto-fires:
 *   - Session duration on page unload (via visibilitychange + beforeunload)
 *   - UTM param capture on every page
 *
 * Privacy: no PII, no third-party calls, no cookies. Anonymous UUID in
 * localStorage only. Daily-salted on the server so cross-day tracking is not
 * possible.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'fl_vid';
  var ENDPOINT_VISIT = '/api/analytics/visit';
  var ENDPOINT_EVENT = '/api/analytics/event';

  // ── Visitor ID ─────────────────────────────────────────────────────────────
  function getOrCreateVisitorId() {
    try {
      var existing = localStorage.getItem(STORAGE_KEY);
      if (existing && /^[a-f0-9-]{8,64}$/i.test(existing)) return existing;
      var newId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      localStorage.setItem(STORAGE_KEY, newId);
      return newId;
    } catch (e) {
      // localStorage blocked (private mode etc.) — use session-only ID
      if (!window._flVidSession) {
        window._flVidSession = 'session-' + Math.random().toString(36).slice(2);
      }
      return window._flVidSession;
    }
  }

  // ── Current user ID (set by app pages after auth) ─────────────────────────
  var _userId = null;

  // ── Parse UTM params from current URL ─────────────────────────────────────
  function getUtmParams() {
    try {
      var params = new URLSearchParams(window.location.search);
      return {
        utm_source:   params.get('utm_source')   || null,
        utm_medium:   params.get('utm_medium')   || null,
        utm_campaign: params.get('utm_campaign') || null,
      };
    } catch (e) {
      return { utm_source: null, utm_medium: null, utm_campaign: null };
    }
  }

  // ── Fire-and-forget POST ───────────────────────────────────────────────────
  // sendBeacon with a raw string sends text/plain — Express only parses
  // application/json. Wrap in a Blob to set the correct Content-Type.
  function post(url, data) {
    try {
      var payload = JSON.stringify(Object.assign({ visitor_id: getOrCreateVisitorId() }, data));
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(url, blob);
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true // works on page unload in modern browsers
      }).catch(function () {});
    } catch (e) {}
  }

  // Alias — both functions now use the same Blob approach
  var beacon = post;

  // ── Session duration tracking ─────────────────────────────────────────────
  var _pageLoadTime = Date.now();

  function fireSessionDuration() {
    var duration = Math.round((Date.now() - _pageLoadTime) / 1000);
    if (duration < 2) return; // skip instant bounces
    beacon(ENDPOINT_EVENT, {
      event_name: 'session_duration',
      event_data: { duration: duration },
      user_id: _userId
    });
  }

  // Fire on tab close / navigation away
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      fireSessionDuration();
    }
  });

  // Fallback for browsers that don't fire visibilitychange on close
  window.addEventListener('beforeunload', function () {
    fireSessionDuration();
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  var FLA = {

    /**
     * Record a page view. Call once per page load.
     * @param {string} page - page slug (e.g. 'landing', 'pricing', 'signup', 'app')
     */
    trackPage: function (page) {
      try {
        var utm = getUtmParams();
        post(ENDPOINT_VISIT, {
          page: page,
          referrer: document.referrer || null,
          utm_source:   utm.utm_source,
          utm_medium:   utm.utm_medium,
          utm_campaign: utm.utm_campaign
        });
      } catch (e) {}
    },

    /**
     * Record a named event.
     * @param {string} name - event name (must be in ALLOWED_EVENTS server-side)
     * @param {object} [data] - optional metadata (plain object, no PII)
     */
    trackEvent: function (name, data) {
      try {
        post(ENDPOINT_EVENT, {
          event_name: name,
          event_data: data || {},
          user_id: _userId
        });
      } catch (e) {}
    },

    /**
     * Set the logged-in user ID. Call after auth is confirmed.
     * @param {number} userId
     */
    setUser: function (userId) {
      if (userId && !isNaN(parseInt(userId))) {
        _userId = parseInt(userId);
      }
    },

    /**
     * Get the anonymous visitor UUID (for external use).
     */
    getVisitorId: function () {
      return getOrCreateVisitorId();
    }
  };

  window.FLA = FLA;

})();
