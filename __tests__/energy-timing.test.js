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

describe('resolveMorningHour', () => {
  test('custom hour always wins over energy', () => {
    expect(resolveMorningHour(6, 'evening')).toBe(6);
    expect(resolveMorningHour(21, 'morning')).toBe(21);
  });

  test('default hour + evening energy → derived 15', () => {
    expect(resolveMorningHour(8, 'evening')).toBe(15);
  });

  test('default hour + afternoon energy → derived 11', () => {
    expect(resolveMorningHour(8, 'afternoon')).toBe(11);
  });

  test('default hour + no energy profile → stays 8', () => {
    expect(resolveMorningHour(8, null)).toBe(8);
    expect(resolveMorningHour(undefined, undefined)).toBe(8);
  });

  test('default hour + morning energy → stays 8', () => {
    expect(resolveMorningHour(8, 'morning')).toBe(8);
  });
});
