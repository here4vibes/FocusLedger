'use strict';
// lib/sentry: what we send to a third party must never carry user emails, and
// console-captured errors must group by shape (not one issue per user/id).

const { _internal: { beforeSend, messageFingerprint } } = require('../lib/sentry');

describe('beforeSend privacy scrubbing', () => {
  test('removes emails from message, console arguments and exception values', () => {
    const event = beforeSend({
      message: 'no matching user | email: Buyer.One@Example.com',
      extra: { arguments: ['[billing] user', 'buyer@example.com', 42] },
      exception: { values: [{ value: 'failed for a.b+c@x.io' }] },
    });
    const json = JSON.stringify(event);
    expect(json).not.toMatch(/@example\.com|@x\.io/i);
    expect(event.message).toContain('[email]');
    expect(event.extra.arguments[2]).toBe(42); // non-strings untouched
  });
});

describe('console message grouping', () => {
  test('same failure for different users → same fingerprint', () => {
    expect(messageFingerprint('[MorningNudge] Error processing user 42 : timeout'))
      .toBe(messageFingerprint('[MorningNudge] Error processing user 43 : timeout'));
  });
  test('Stripe ids (incl. cs_live_ / cs_test_) and hex ids are normalised', () => {
    expect(messageFingerprint('session cs_live_a1B2c3D4 failed'))
      .toBe(messageFingerprint('session cs_test_zz9YY8 failed'));
    expect(messageFingerprint('sub sub_1AbC failed')).toBe(messageFingerprint('sub sub_9XyZ failed'));
  });
  test('different failures stay distinct', () => {
    expect(messageFingerprint('[billing] activation failed'))
      .not.toBe(messageFingerprint('[billing] cancel failed'));
  });
  test('console events get the stable fingerprint; exceptions keep stack grouping', () => {
    const consoleEvt = beforeSend({ logger: 'console', message: '[x] failed for user 7' });
    expect(consoleEvt.fingerprint).toEqual(['console', '[x] failed for user #']);
    const excEvt = beforeSend({ logger: 'console', message: 'boom', exception: { values: [{ value: 'boom' }] } });
    expect(excEvt.fingerprint).toBeUndefined();
  });
});
