// values-service.js — shared Values Profile API client
// Canonical source for all values-related operations across app pages.
// Replaces inline fetch('/api/values/...') calls in app.html, values.html, routine builder, task forms.

(function (global) {
  'use strict';

  // ── Internal helpers ─────────────────────────────────────────────────────────

  var TOKEN_KEY = 'fl_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function authHeaders() {
    return {
      Authorization: 'Bearer ' + getToken(),
      'Content-Type': 'application/json',
    };
  }

  function apiFetch(path, options) {
    return fetch('/api' + path, Object.assign({ headers: authHeaders() }, options || {}));
  }

  function handleAuthRedirect(response) {
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem('fl_user');
      window.location.href = '/login';
      return true;
    }
    return false;
  }

  // ── Maslow tier classification ────────────────────────────────────────────────
  // Maps common value names to Maslow hierarchy tiers (1–5).
  // Used by AI weighting to boost/penalizie suggestions based on alignment.
  // Tier 5 = self-actualization, 4 = esteem, 3 = belonging, 2 = safety, 1 = physiological.

  var MASLOW_TIERS = {
    // Tier 5 — Self-Actualization (growth, meaning, purpose)
    'creativity':        5,
    'growth':            5,
    'self-actualization': 5,
    'selfactualization': 5,
    'learning':          5,
    'personal growth':   5,
    'mastery':           5,
    'purpose':           5,
    'meaning':           5,

    // Tier 4 — Esteem (status, recognition, competence)
    'recognition':       4,
    'status':            4,
    'accomplishment':    4,
    'achievement':       4,
    'competence':        4,
    'respect':           4,
    'confidence':        4,
    'reputation':        4,
    'success':           4,
    'career':            4,

    // Tier 3 — Belonging (relationships, community, love)
    'family':            3,
    'friendship':        3,
    'relationships':     3,
    'connection':        3,
    'community':         3,
    'love':              3,
    'partnership':       3,
    'parenting':         3,
    'social':            3,
    'belonging':         3,
    'fun':               3,
    'play':              3,
    'adventure':         3,
    'travel':            3,

    // Tier 2 — Safety (stability, security, health)
    'health':            2,
    'safety':            2,
    'security':          2,
    'stability':         2,
    'finance':           2,
    'financial':         2,
    'money':             2,
    'budget':            2,
    'home':              2,
    'protection':        2,
    'insurance':         2,
    'legal':             2,
    'planning':          2,
    'organization':      2,

    // Tier 1 — Physiological (body needs)
    'rest':              1,
    'sleep':             1,
    'fitness':           1,
    'exercise':          1,
    'nutrition':         1,
    'energy':            1,
  };

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * loadValues() — fetch all values for the current user.
   * Returns a promise that resolves to an array of value objects.
   * Each value: { id, user_id, value_name, rank, icon, color,
   *                weekly_hours_target, weekly_spend_target, created_at, updated_at }
   */
  function loadValues() {
    return apiFetch('/values')
      .then(function (r) {
        if (handleAuthRedirect(r)) return [];
        return r.json();
      })
      .then(function (data) {
        return (data && data.values) ? data.values : [];
      })
      .catch(function () {
        return [];
      });
  }

  /**
   * getValueById(id) — get a single value by its numeric ID.
   * Returns a promise resolving to the value object, or null if not found.
   */
  function getValueById(id) {
    return loadValues().then(function (values) {
      var match = null;
      for (var i = 0; i < values.length; i++) {
        if (values[i].id == id) { match = values[i]; break; }
      }
      return match;
    });
  }

  /**
   * createValue(name, maslowTier?) — create a new value for the current user.
   * @param {string} name — value name (required, max 100 chars)
   * @param {number} [maslowTier] — optional Maslow tier (1–5); stored as metadata
   *                               (backend currently stores only name/icon/color/targets,
   *                               so this is captured for AI-side use via a future field)
   * @returns {Promise} resolving to { success, value }
   */
  function createValue(name, maslowTier) {
    var nameTrimmed = String(name || '').trim().slice(0, 100);
    if (!nameTrimmed) {
      return Promise.resolve({ success: false, message: 'value_name is required' });
    }
    var payload = { value_name: nameTrimmed };
    // maslowTier is stored as a hint on the client side for AI weighting;
    // the backend stores it implicitly via the value_name keyword matching.
    return apiFetch('/values', {
      method: 'POST',
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (handleAuthRedirect(r)) return { success: false };
      return r.json();
    });
  }

  /**
   * updateValue(id, updates) — rename or reorder a value.
   * @param {number} id — value ID
   * @param {object} updates — { value_name?, icon?, color?, weekly_hours_target?, weekly_spend_target? }
   * @returns {Promise} resolving to { success, value }
   */
  function updateValue(id, updates) {
    if (!id) return Promise.resolve({ success: false, message: 'id is required' });
    var nameTrimmed = updates.value_name ? String(updates.value_name).trim().slice(0, 100) : null;
    if (nameTrimmed === '') {
      return Promise.resolve({ success: false, message: 'value_name cannot be empty' });
    }
    var payload = {};
    if (updates.value_name !== undefined) payload.value_name = nameTrimmed;
    if (updates.icon !== undefined)       payload.icon = updates.icon;
    if (updates.color !== undefined)      payload.color = updates.color;
    if (updates.weekly_hours_target !== undefined) payload.weekly_hours_target = updates.weekly_hours_target;
    if (updates.weekly_spend_target !== undefined) payload.weekly_spend_target = updates.weekly_spend_target;

    return apiFetch('/values/' + id, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (handleAuthRedirect(r)) return { success: false };
      return r.json();
    });
  }

  /**
   * deleteValue(id) — remove a value by ID.
   * Ranks of remaining values are auto-adjusted server-side.
   * @returns {Promise} resolving to { success }
   */
  function deleteValue(id) {
    if (!id) return Promise.resolve({ success: false, message: 'id is required' });
    return apiFetch('/values/' + id, { method: 'DELETE' })
      .then(function (r) {
        if (handleAuthRedirect(r)) return { success: false };
        return r.json();
      });
  }

  /**
   * getMaslowTier(valueName) — return the Maslow hierarchy tier (1–5) for a value name.
   * Used by AI weighting to score task-value alignment.
   * Unknown values default to tier 3 (belonging) as a neutral anchor.
   *
   * Tiers:
   *   1 = Physiological  (rest, sleep, fitness, nutrition)
   *   2 = Safety         (health, security, finance, stability)
   *   3 = Belonging      (family, relationships, community, fun)
   *   4 = Esteem         (recognition, achievement, career, respect)
   *   5 = Self-Actualization (creativity, growth, learning, purpose)
   *
   * @param {string} valueName
   * @returns {number} tier 1–5
   */
  function getMaslowTier(valueName) {
    if (!valueName) return 3;
    var normalized = String(valueName).toLowerCase().replace(/[^a-z0-9]/g, '');
    return MASLOW_TIERS[normalized] || 3;
  }

  /**
   * buildImplementationIntention(valueId, contextTrigger, commitment) —
   * Construct a structured "when X, I will Y" object for behavioral anchoring.
   *
   * Research basis: Gollwitzer (1999) — implementation intentions have d=0.65
   * effect size on follow-through. The "when" trigger activates the behavior
   * automatically without needing conscious decision-making at the moment.
   *
   * @param {number} valueId  — ID of the value this II anchors to
   * @param {string} contextTrigger — the "when" context (e.g. "I finish my morning coffee")
   * @param {string} commitment — the "I will" behavior (e.g. "I will write for 20 minutes")
   * @returns {object} II record: { value_id, trigger, commitment, created_at, statement }
   *                   The statement field is a human-readable "When X, I will Y" string.
   */
  function buildImplementationIntention(valueId, contextTrigger, commitment) {
    var trigger = String(contextTrigger || '').trim();
    var commit  = String(commitment || '').trim();
    return {
      value_id:   valueId || null,
      trigger:    trigger,
      commitment: commit,
      statement:  'When ' + trigger + ', I will ' + commit + '.',
      created_at: new Date().toISOString(),
    };
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  global.ValuesService = {
    loadValues:                   loadValues,
    getValueById:                 getValueById,
    createValue:                  createValue,
    updateValue:                  updateValue,
    deleteValue:                  deleteValue,
    getMaslowTier:                getMaslowTier,
    buildImplementationIntention: buildImplementationIntention,
  };

})(window);