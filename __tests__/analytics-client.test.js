'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/analytics.js'), 'utf8');

function load({ webdriver, search = '', referrer = '', store = {} }) {
  const beacons = [];
  const bodies = [];
  const window = {};
  const ctx = {
    window,
    navigator: { webdriver, sendBeacon: (url, blob) => { beacons.push(url); bodies.push(JSON.parse(blob.parts[0])); return true; } },
    document: { addEventListener() {}, referrer, visibilityState: 'visible' },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    location: { search, pathname: '/', hostname: 'focusledger.net' },
    URL,
    URLSearchParams,
    Blob: function Blob(parts, opts) { this.parts = parts; this.opts = opts; },
    fetch: () => Promise.resolve(),
    Math, JSON, Date, Object, Array, parseInt, isNaN,
  };
  window.addEventListener = () => {};
  ctx.window.location = ctx.location;
  vm.runInNewContext(SRC, ctx);
  return { FLA: window.FLA, beacons, bodies, store };
}

test('a real visitor is recorded', () => {
  const { FLA, beacons } = load({ webdriver: false });
  FLA.trackPage('landing');
  FLA.trackEvent('funnel_landing_visit');
  expect(beacons).toEqual(['/api/analytics/visit', '/api/analytics/event']);
});

test('an automated browser (Playwright/Selenium: navigator.webdriver) sends nothing', () => {
  const { FLA, beacons } = load({ webdriver: true });
  FLA.trackPage('landing');
  FLA.trackEvent('funnel_landing_visit');
  expect(beacons).toEqual([]);
});

test('first-touch attribution is captured once and rides on funnel events', () => {
  const { FLA, bodies, store } = load({
    webdriver: false,
    search: '?utm_source=facebook&utm_campaign=oct&fbclid=abc123',
    referrer: 'https://m.facebook.com/some/path?x=1',
  });
  const saved = JSON.parse(store.fl_attribution);
  expect(saved).toMatchObject({ utm_source: 'facebook', utm_campaign: 'oct', fbclid: 'abc123', referrer_domain: 'm.facebook.com', landing_page: '/' });
  FLA.trackPage('landing');
  FLA.trackEvent('funnel_landing_visit');
  FLA.trackEvent('feature_first_task');
  expect(bodies[0].referrer).toBe('m.facebook.com'); // domain only
  expect(bodies[1].event_data.attribution.utm_source).toBe('facebook');
  expect(bodies[2].event_data.attribution).toBeUndefined();

  // A later visit with different UTMs keeps the first touch.
  const again = load({ webdriver: false, search: '?utm_source=google', store });
  expect(JSON.parse(again.store.fl_attribution).utm_source).toBe('facebook');
});

test('a direct visit or a signed-in user stores no attribution', () => {
  expect(load({ webdriver: false }).store.fl_attribution).toBeUndefined();
  expect(load({ webdriver: false, search: '?utm_source=x', store: { fl_token: 't' } }).store.fl_attribution).toBeUndefined();
});
