'use strict';
/**
 * Ad / channel attribution: sanitize what the browser captured on first
 * landing (public/js/analytics.js, localStorage fl_attribution) before it goes
 * into analytics event_data or the users row at signup.
 *
 * Privacy: referrers are reduced to a bare domain (no path or query, which can
 * carry search terms or ids); click ids are truncated; nothing else is kept.
 */

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const CLICK_ID_MAX = 64;
// Our own hosts: a referrer from here is internal navigation, not a source.
const OWN_DOMAINS = ['focusledger.net', 'onrender.com', 'localhost', '127.0.0.1'];

/** Marketer-set tag value: letters, digits, _ - . + space; max 100. */
function sanitizeUtmValue(val) {
  if (val == null) return null;
  const s = String(val).trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-.+]/g, '')
    .slice(0, 100);
  return s || null;
}

/** Click id (fbclid / gclid): URL-safe characters, truncated. */
function sanitizeClickId(val) {
  if (val == null) return null;
  const s = String(val).replace(/[^A-Za-z0-9_\-.]/g, '').slice(0, CLICK_ID_MAX);
  return s || null;
}

/**
 * A referrer URL (or bare host) → its domain, lower-cased, without "www." and
 * port. Null for our own hosts, non-http(s) and garbage.
 */
function referrerDomain(ref) {
  if (!ref || typeof ref !== 'string') return null;
  let host;
  const raw = ref.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch { // silent-ok: a client-supplied referrer that isn't a URL is dropped
      return null;
    }
  } else if (/^[a-z0-9.-]+(:\d+)?$/i.test(raw)) {
    host = raw.split(':')[0];
  } else {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return null;
  if (OWN_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return null;
  return host;
}

/**
 * Whitelist + clean an attribution object from the browser. Accepts the
 * legacy `signup_referrer` (full URL) key too. Returns null when nothing
 * useful is left.
 * @returns {null|{utm_source?,utm_medium?,utm_campaign?,utm_content?,utm_term?,
 *   fbclid?,gclid?,referrer_domain?,landing_page?,first_seen?}}
 */
function sanitizeAttribution(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of UTM_KEYS) {
    const v = sanitizeUtmValue(raw[k]);
    if (v) out[k] = v;
  }
  const fb = sanitizeClickId(raw.fbclid);
  if (fb) out.fbclid = fb;
  const g = sanitizeClickId(raw.gclid);
  if (g) out.gclid = g;
  const dom = referrerDomain(raw.referrer_domain || raw.signup_referrer || raw.referrer);
  if (dom) out.referrer_domain = dom;
  if (typeof raw.landing_page === 'string' && /^\/[a-z0-9\-/]{0,60}$/i.test(raw.landing_page)) {
    out.landing_page = raw.landing_page.toLowerCase();
  }
  if (typeof raw.first_seen === 'string' && !Number.isNaN(Date.parse(raw.first_seen))) {
    out.first_seen = new Date(raw.first_seen).toISOString();
  }
  const meaningful = UTM_KEYS.some(k => out[k]) || out.fbclid || out.gclid || out.referrer_domain;
  return meaningful ? out : null;
}

/**
 * One label per signup for "signups by source": utm_source, else the ad
 * click id's network, else the referring domain, else (direct).
 */
function sourceLabel(attr) {
  if (!attr) return '(direct)';
  if (attr.utm_source) return attr.utm_source;
  if (attr.fbclid) return 'facebook';
  if (attr.gclid) return 'google';
  if (attr.referrer_domain) return attr.referrer_domain;
  return '(direct)';
}

module.exports = {
  sanitizeAttribution, sanitizeUtmValue, sanitizeClickId, referrerDomain, sourceLabel, UTM_KEYS,
};
