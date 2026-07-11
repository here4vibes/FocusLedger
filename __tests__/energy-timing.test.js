'use strict';
/**
 * Unit tests for energy-based morning-nudge timing.
 */

const {
  DEFAULT_MORNING_HOUR,
  energyToMorningHour,
  resolveMorningHour,
} = require('../lib/energy-timing');

describe('energyToMorningHour', () => {
  test('morning energy → 8', () => expect(energyToMorningHour('morning')).toBe(8));
  test('afternoon energy → 11', () => expect(energyToMorningHour('afternoon')).toBe(11));
  test('evening energy → 15', () => expect(energyToMorningHour('evening')).toBe(15));
  test('case-insensitive', () => expect(energyToMorningHour('EVENING')).toBe(15));
  test('null → default', () => expect(energyToMorningHour(null)).toBe(DEFAULT_MORNING_HOUR));
  test('unknown label → default', () => expect(energyToMorningHour('whenever')).toBe(DEFAULT_MORNING_HOUR));
});

describe('resolveMorningHour (NULL-means-default)', () => {
  test('any explicit numeric hour always wins over energy', () => {
    expect(resolveMorningHour(6, 'evening')).toBe(6);
    expect(resolveMorningHour(21, 'morning')).toBe(21);
  });

  test('an EXPLICIT 8 is honored — not confused with the default', () => {
    expect(resolveMorningHour(8, 'evening')).toBe(8);
    expect(resolveMorningHour(8, 'afternoon')).toBe(8);
  });

  test('null (never set) + evening energy → derived 15', () => {
    expect(resolveMorningHour(null, 'evening')).toBe(15);
  });

  test('null + afternoon energy → derived 11', () => {
    expect(resolveMorningHour(null, 'afternoon')).toBe(11);
  });

  test('null + no energy profile → default 8', () => {
    expect(resolveMorningHour(null, null)).toBe(8);
    expect(resolveMorningHour(undefined, undefined)).toBe(8);
  });

  test('non-finite configured values fall through to energy', () => {
    expect(resolveMorningHour(NaN, 'evening')).toBe(15);
  });
});
