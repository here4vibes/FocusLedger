'use strict';
/**
 * Analytics writes (routes/analytics.js) and the acquisition report behind
 * GET /api/admin/attribution. Anonymous tables only: visitor_hash is a
 * daily-salted hash, so "visitors" here are visitor-days.
 */
const { referrerDomain, sourceLabel } = require('../lib/attribution');

async function insertVisit(pool, v) {
  await pool.query(
    `INSERT INTO visitor_sessions
       (visitor_hash, page, visited_at, referrer, utm_source, utm_medium, utm_campaign, device_type)
     VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)`,
    [v.visitorHash, v.page, v.referrer, v.utmSource, v.utmMedium, v.utmCampaign, v.device]
  );
}

async function insertEvent(pool, e) {
  await pool.query(
    `INSERT INTO analytics_events (visitor_hash, user_id, event_name, event_data, occurred_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [e.visitorHash, e.userId, e.eventName, JSON.stringify(e.eventData || {})]
  );
}

/** Count one analytics request dropped as bot/CI (lib/analytics-filter.js). */
async function countFiltered(pool, reason, kind) {
  await pool.query(
    `INSERT INTO analytics_filtered_daily (day, reason, kind, hits)
     VALUES ((NOW() AT TIME ZONE 'UTC')::date, $1, $2, 1)
     ON CONFLICT (day, reason, kind) DO UPDATE SET hits = analytics_filtered_daily.hits + 1`,
    [reason, kind]
  );
}

// Events that only a person on the page produces: scrolling, staying, typing.
// A bot that loads the page and leaves fires none of them.
const ENGAGED_EVENTS = [
  'funnel_scroll_25', 'funnel_scroll_50', 'funnel_scroll_75', 'funnel_scroll_100',
  'funnel_signup_start', 'funnel_demo_interact', 'funnel_lead_magnet_click',
  'cta_signup_free', 'cta_go_pro', 'cta_pricing_free', 'cta_pricing_pro', 'demo_breakdown_used',
];

function groupCount(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const key = keyFn(it);
    const id = JSON.stringify(key);
    if (!map.has(id)) map.set(id, { ...key, count: 0 });
    map.get(id).count++;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Acquisition report for [from, to] (UTC dates, inclusive).
 * @returns {Promise<object>} see GET /api/admin/attribution
 */
async function getAttributionReport(pool, { from, to }) {
  const range = [from, to];
  const RANGE_EV = `occurred_at >= $1::date AND occurred_at < ($2::date + 1)`;

  const [visitors, funnel, engaged, firstVisits, signups, filtered] = await Promise.all([
    pool.query(
      `SELECT COUNT(DISTINCT visitor_hash)::int AS n FROM visitor_sessions
       WHERE visited_at >= $1::date AND visited_at < ($2::date + 1)`, range),
    pool.query(
      `SELECT event_name, COUNT(DISTINCT visitor_hash)::int AS n FROM analytics_events
       WHERE ${RANGE_EV} AND event_name IN ('funnel_landing_visit','funnel_signup_visit','funnel_signup_complete')
       GROUP BY event_name`, range),
    pool.query(
      `SELECT COUNT(DISTINCT visitor_hash)::int AS n FROM analytics_events
       WHERE ${RANGE_EV} AND (event_name = ANY($3)
         OR (event_name = 'session_duration' AND (event_data->>'duration') ~ '^[0-9]+$'
             AND (event_data->>'duration')::int >= 5))`, [...range, ENGAGED_EVENTS]),
    // Each visitor-day's first page view: its source.
    pool.query(
      `SELECT DISTINCT ON (visitor_hash) utm_source, utm_campaign, referrer
       FROM visitor_sessions
       WHERE visited_at >= $1::date AND visited_at < ($2::date + 1)
       ORDER BY visitor_hash, visited_at`, range),
    pool.query(
      `SELECT first_touch, utm_source, utm_medium, utm_campaign, signup_referrer
       FROM users
       WHERE COALESCE(is_qa_user, false) = false
         AND created_at >= $1::date AND created_at < ($2::date + 1)`, range),
    pool.query(
      `SELECT reason, SUM(hits)::int AS hits FROM analytics_filtered_daily
       WHERE day BETWEEN $1::date AND $2::date GROUP BY reason ORDER BY hits DESC`, range),
  ]);

  const f = Object.fromEntries(funnel.rows.map(r => [r.event_name, r.n]));

  const visitorsBySource = groupCount(firstVisits.rows, r => ({
    source: r.utm_source || referrerDomain(r.referrer) || '(direct)',
    campaign: r.utm_campaign || null,
  })).map(({ count, ...k }) => ({ ...k, visitors: count }));

  const signupRows = signups.rows.map(u => {
    const ft = u.first_touch && typeof u.first_touch === 'object' ? u.first_touch : {};
    const attr = {
      utm_source: ft.utm_source || u.utm_source || null,
      utm_medium: ft.utm_medium || u.utm_medium || null,
      utm_campaign: ft.utm_campaign || u.utm_campaign || null,
      utm_content: ft.utm_content || null,
      fbclid: ft.fbclid || null,
      gclid: ft.gclid || null,
      referrer_domain: ft.referrer_domain || referrerDomain(u.signup_referrer) || null,
    };
    return attr;
  });
  const signupsBySource = groupCount(signupRows, a => ({
    source: sourceLabel(a),
    medium: a.utm_medium,
    campaign: a.utm_campaign,
    content: a.utm_content,
  })).map(({ count, ...k }) => ({ ...k, signups: count }));

  const filteredTotal = filtered.rows.reduce((s, r) => s + r.hits, 0);
  return {
    from, to,
    visitors: visitors.rows[0].n,
    engaged_visitors: engaged.rows[0].n,
    landing_visitors: f.funnel_landing_visit || 0,
    signup_page_visitors: f.funnel_signup_visit || 0,
    signups: signupRows.length,
    signups_attributed: signupRows.filter(a => sourceLabel(a) !== '(direct)').length,
    signups_by_source: signupsBySource,
    visitors_by_source: visitorsBySource.slice(0, 25),
    filtered: { total: filteredTotal, by_reason: filtered.rows },
  };
}

module.exports = { insertVisit, insertEvent, countFiltered, getAttributionReport, ENGAGED_EVENTS };
