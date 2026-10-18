'use strict';
const {
  sanitizeAttribution, referrerDomain, sanitizeUtmValue, sanitizeClickId, sourceLabel,
} = require('../lib/attribution');

describe('referrerDomain', () => {
  test('keeps only the domain: no path, query, port or www', () => {
    expect(referrerDomain('https://www.google.com/search?q=adhd+money+app&rlz=1')).toBe('google.com');
    expect(referrerDomain('http://l.facebook.com:443/l.php?u=https%3A%2F%2Ffocusledger.net')).toBe('l.facebook.com');
    expect(referrerDomain('reddit.com')).toBe('reddit.com');
  });
  test('our own hosts are internal, not a source', () => {
    expect(referrerDomain('https://focusledger.net/pricing')).toBeNull();
    expect(referrerDomain('https://focusledger-mwn3.onrender.com/')).toBeNull();
    expect(referrerDomain('http://localhost:3995/')).toBeNull();
  });
  test('garbage and non-http schemes are dropped', () => {
    expect(referrerDomain('javascript:alert(1)')).toBeNull();
    expect(referrerDomain('not a url at all')).toBeNull();
    expect(referrerDomain('')).toBeNull();
    expect(referrerDomain(42)).toBeNull();
  });
});

describe('sanitizeAttribution', () => {
  test('whitelists keys, cleans values, truncates click ids', () => {
    const out = sanitizeAttribution({
      utm_source: 'Facebook', utm_medium: 'paid social', utm_campaign: 'oct<script>-test',
      utm_content: 'video_a', utm_term: 'adhd',
      fbclid: 'IwAR' + 'x'.repeat(200), gclid: 'abc/def?',
      referrer_domain: 'https://m.facebook.com/some/path?id=123',
      landing_page: '/pricing', first_seen: '2026-10-18T12:00:00Z',
      email: 'someone@example.com', password: 'nope',
    });
    expect(out).toEqual({
      utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'octscript-test',
      utm_content: 'video_a', utm_term: 'adhd',
      fbclid: ('IwAR' + 'x'.repeat(200)).slice(0, 64), gclid: 'abcdef',
      referrer_domain: 'm.facebook.com', landing_page: '/pricing',
      first_seen: '2026-10-18T12:00:00.000Z',
    });
  });
  test('legacy signup_referrer (full URL) becomes a domain', () => {
    expect(sanitizeAttribution({ signup_referrer: 'https://news.ycombinator.com/item?id=1' }))
      .toEqual({ referrer_domain: 'news.ycombinator.com' });
  });
  test('nothing useful → null', () => {
    expect(sanitizeAttribution(null)).toBeNull();
    expect(sanitizeAttribution([])).toBeNull();
    expect(sanitizeAttribution({ landing_page: '/' })).toBeNull();
    expect(sanitizeAttribution({ signup_referrer: 'https://focusledger.net/' })).toBeNull();
    expect(sanitizeAttribution({ landing_page: '/../etc?x=1', utm_source: 'x' })).toEqual({ utm_source: 'x' });
  });
  test('value helpers', () => {
    expect(sanitizeUtmValue('  ')).toBeNull();
    expect(sanitizeUtmValue('a'.repeat(300))).toHaveLength(100);
    expect(sanitizeClickId(null)).toBeNull();
  });
});

test('sourceLabel: utm_source, then click-id network, then referrer, else direct', () => {
  expect(sourceLabel({ utm_source: 'facebook', fbclid: 'x' })).toBe('facebook');
  expect(sourceLabel({ fbclid: 'x' })).toBe('facebook');
  expect(sourceLabel({ gclid: 'x' })).toBe('google');
  expect(sourceLabel({ referrer_domain: 'reddit.com' })).toBe('reddit.com');
  expect(sourceLabel({})).toBe('(direct)');
  expect(sourceLabel(null)).toBe('(direct)');
});
