'use strict';
const { workHoursPhrase, reviewPushBody } = require('../lib/work-hours');

describe('workHoursPhrase', () => {
  test('no rate or no amount → null (caller leaves it out)', () => {
    expect(workHoursPhrase(50, null)).toBeNull();
    expect(workHoursPhrase(50, 0)).toBeNull();
    expect(workHoursPhrase(50, '')).toBeNull();
    expect(workHoursPhrase(0, 40)).toBeNull();
  });
  test('minutes under an hour, rounded to 5 from 10 min up', () => {
    expect(workHoursPhrase(0.2, 40)).toBe('under a minute of work');
    expect(workHoursPhrase(4, 40)).toBe('about 6 min of work');
    expect(workHoursPhrase(30, 40)).toBe('about 45 min of work');
    expect(workHoursPhrase(31, 40)).toBe('about 45 min of work');
  });
  test('hours with one decimal, singular at exactly 1', () => {
    expect(workHoursPhrase(40, 40)).toBe('about 1 hour of work');
    expect(workHoursPhrase(84.2, 40)).toBe('about 2.1 hours of work');
    expect(workHoursPhrase(120, '40.00')).toBe('about 3 hours of work');
    expect(workHoursPhrase(39.9, 40)).toBe('about 1 hour of work');
  });
});

describe('reviewPushBody', () => {
  test('with an hourly rate', () => {
    expect(reviewPushBody({ count: 3, totalCents: 8420, hourlyRate: '40.00' }))
      .toBe('3 charges to review ($84.20 · about 2.1 hours of work). Tap to check in.');
  });
  test('one charge, no rate set', () => {
    expect(reviewPushBody({ count: 1, totalCents: 1299, hourlyRate: null }))
      .toBe('1 charge to review ($12.99). Tap to check in.');
  });
  test('thousands separator', () => {
    expect(reviewPushBody({ count: 2, totalCents: 123456, hourlyRate: 50 }))
      .toBe('2 charges to review ($1,234.56 · about 24.7 hours of work). Tap to check in.');
  });
});
