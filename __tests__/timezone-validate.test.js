'use strict';
/**
 * Regression test: validateTimezone was imported by routes/auth.js but never
 * exported from lib/timezone.js, so every EMAIL signup threw
 * "validateTimezone is not a function" before the user row was created
 * (Google OAuth signup didn't call it, which is why only email signup broke).
 */
const { validateTimezone } = require('../lib/timezone');

describe('validateTimezone', () => {
  test('is a function (the actual signup bug)', () => {
    expect(typeof validateTimezone).toBe('function');
  });

  test('returns the zone for valid IANA timezones', () => {
    expect(validateTimezone('America/New_York')).toBe('America/New_York');
    expect(validateTimezone('Europe/London')).toBe('Europe/London');
    expect(validateTimezone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(validateTimezone('UTC')).toBe('UTC');
  });

  test('returns null for invalid / missing input', () => {
    expect(validateTimezone('Not/AZone')).toBeNull();
    expect(validateTimezone('')).toBeNull();
    expect(validateTimezone(null)).toBeNull();
    expect(validateTimezone(undefined)).toBeNull();
    expect(validateTimezone(12345)).toBeNull();
    expect(validateTimezone('x'.repeat(100))).toBeNull();
  });
});
