'use strict';
/**
 * context-service.js — Stale-while-revalidate cache for /api/home-context.
 *
 * Problem: ADHD users lose focus when the dashboard shows a blank/loading
 * state. This service serves cached data instantly from localStorage and
 * refreshes in the background, so the UI is never blank.
 *
 * Usage:
 *   ContextService.onReady(function(ctx) { ... }); // fires immediately (cached) + on refresh
 *   ContextService.refresh();                       // force a background refresh
 *
 * Cache key: fl_home_ctx  (JSON: { data, ts })
 * Revalidates: always in background; renders cached copy first if < 5 min old.
 */
(function (global) {
  var CACHE_KEY = 'fl_home_ctx';
  var MAX_STALE_MS = 5 * 60 * 1000; // 5 minutes — serve cached, still revalidate
  var _subscribers = [];
  var _lastData = null;
  var _fetchInFlight = false;

  function getToken() {
    return localStorage.getItem('fl_token') || '';
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.data ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: data, ts: Date.now() }));
    } catch (e) {
      // Storage quota exceeded — silently ignore, will re-fetch next load
    }
  }

  function notify(data) {
    _lastData = data;
    for (var i = 0; i < _subscribers.length; i++) {
      try { _subscribers[i](data); } catch (e) { /* subscriber error should not stop others */ }
    }
  }

  function doFetch() {
    if (_fetchInFlight) return;
    var token = getToken();
    if (!token) return;
    _fetchInFlight = true;
    var localHour = new Date().getHours();
    fetch('/api/home-context?localHour=' + localHour, {
      headers: { Authorization: 'Bearer ' + token }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        _fetchInFlight = false;
        if (data && data.success) {
          writeCache(data);
          notify(data);
        }
      })
      .catch(function () { _fetchInFlight = false; });
  }

  /**
   * Register a callback. Fires immediately with cached data (if fresh enough),
   * then again once the background refresh completes.
   * @param {function} cb  — called with the context data object
   */
  function onReady(cb) {
    _subscribers.push(cb);

    // Fire with cached data immediately if available
    var cached = readCache();
    if (cached) {
      var age = Date.now() - (cached.ts || 0);
      if (age < MAX_STALE_MS) {
        try { cb(cached.data); } catch (e) {}
      }
    }

    // Always kick off a background refresh so data stays fresh
    doFetch();
  }

  /**
   * Force an immediate background refresh (e.g. after a task completion).
   */
  function refresh() {
    _fetchInFlight = false; // allow a new fetch even if one was in flight
    doFetch();
  }

  /**
   * Return the last successfully fetched/cached data synchronously, or null.
   */
  function latest() {
    return _lastData || (readCache() || {}).data || null;
  }

  global.ContextService = { onReady: onReady, refresh: refresh, latest: latest };
}(window));
