'use strict';
const { classifyTraffic, isBotUserAgent } = require('../lib/analytics-filter');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const FB_IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.0;FBBV/1;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]';

test('ordinary browsers, including the Facebook in-app browser ads open in, are real', () => {
  for (const ua of [CHROME, IPHONE, FB_IN_APP]) {
    expect(classifyTraffic({ 'user-agent': ua })).toBeNull();
  }
});

test('a missing user agent is filtered', () => {
  expect(classifyTraffic({})).toBe('missing_ua');
  expect(classifyTraffic({ 'user-agent': '   ' })).toBe('missing_ua');
});

test('headless browsers and automation are bots', () => {
  expect(classifyTraffic({ 'user-agent': CHROME.replace('Chrome/', 'HeadlessChrome/') })).toBe('bot_ua');
  expect(isBotUserAgent('Mozilla/5.0 (X11; Linux x86_64) Playwright/1.48')).toBe(true);
});

test('crawlers, AI bots, HTTP clients and monitors are bots', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'meta-externalagent/1.1',
    'curl/8.4.0',
    'python-requests/2.31',
    'node',
    'Mozilla/5.0 (compatible; UptimeRobot/2.0)',
    'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109 Mobile Safari/537.36 Chrome-Lighthouse',
  ]) {
    expect(classifyTraffic({ 'user-agent': ua })).toBe('bot_ua');
  }
});

test('our own CI is marked by header or UA token, even with a normal browser UA', () => {
  expect(classifyTraffic({ 'user-agent': IPHONE, 'x-fl-automation': 'smoke' })).toBe('ci');
  expect(classifyTraffic({ 'user-agent': 'FocusLedger-signup-monitor (+https://github.com/x)' })).toBe('ci');
  expect(classifyTraffic({ 'user-agent': `${CHROME} FocusLedger-CI` })).toBe('ci');
  expect(classifyTraffic({ 'user-agent': 'FocusLedger-uptime/1.0 (+https://github.com/x)' })).toBe('ci');
  expect(classifyTraffic({ 'user-agent': 'FocusLedger-uptime/1.0', 'x-fl-automation': 'uptime' })).toBe('ci');
});
