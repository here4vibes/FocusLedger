'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/analytics.js'), 'utf8');

function load({ webdriver }) {
  const beacons = [];
  const store = {};
  const window = {};
  const ctx = {
    window,
    navigator: { webdriver, sendBeacon: (url, blob) => { beacons.push(url); return true; } },
    document: { addEventListener() {}, referrer: '', visibilityState: 'visible' },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    location: { search: '' },
    URLSearchParams,
    Blob: function Blob(parts, opts) { this.parts = parts; this.opts = opts; },
    fetch: () => Promise.resolve(),
    Math, JSON, Date, Object, parseInt, isNaN,
  };
  window.addEventListener = () => {};
  ctx.window.location = ctx.location;
  vm.runInNewContext(SRC, ctx);
  return { FLA: window.FLA, beacons };
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
