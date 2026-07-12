'use strict';
/**
 * Tests for the "reply 'no more'" opt-out mechanism.
 * The stakes are asymmetric: a missed opt-out is a credibility/compliance
 * failure; a false positive silently unsubscribes an engaged user. Both
 * directions are covered.
 */

const {
  isOptOutMessage,
  isMarketingTemplate,
  normalizeEmail,
} = require('../lib/emailSuppression');

describe('isOptOutMessage — catches real opt-outs', () => {
  test('bare "no more" reply (exactly what our footer instructs)', () => {
    expect(isOptOutMessage('Re: You got in early', 'no more')).toBe(true);
    expect(isOptOutMessage('Re: hi', 'No more.')).toBe(true);
    expect(isOptOutMessage('', '"no more"')).toBe(true);
    expect(isOptOutMessage('', '\n\n  No More  \n> On Jul 12, FocusLedger wrote:')).toBe(true);
  });

  test('bare "stop"', () => {
    expect(isOptOutMessage('', 'STOP')).toBe(true);
    expect(isOptOutMessage('', 'stop.')).toBe(true);
  });

  test('explicit phrases anywhere', () => {
    expect(isOptOutMessage('unsubscribe', '')).toBe(true);
    expect(isOptOutMessage('', 'Please remove me from this list, thanks')).toBe(true);
    expect(isOptOutMessage('', 'I want to opt out of these')).toBe(true);
    expect(isOptOutMessage('', 'stop sending me these please')).toBe(true);
    expect(isOptOutMessage('', 'No more emails please!')).toBe(true);
  });
});

describe('isOptOutMessage — never false-positives on engaged replies', () => {
  test('enthusiastic replies containing the words mid-sentence', () => {
    expect(isOptOutMessage('Re: beta', "I can't stop using this app, it's great")).toBe(false);
    expect(isOptOutMessage('', 'There is no more important app on my phone. Turn it on!')).toBe(false);
    expect(isOptOutMessage('', 'turn it on')).toBe(false); // the Autopilot request!
  });

  test('ordinary support replies', () => {
    expect(isOptOutMessage('Re: bug', 'The triage screen stopped working yesterday')).toBe(false);
    expect(isOptOutMessage('', 'Love the new reveal feature')).toBe(false);
    expect(isOptOutMessage('', '')).toBe(false);
    expect(isOptOutMessage(null, null)).toBe(false);
  });
});

describe('isMarketingTemplate — the suppression boundary', () => {
  test('marketing templates are suppressed', () => {
    for (const t of ['campaign_7', 'beta_autopilot_2026_07', 'weekly_nudge',
                     're_engagement', 'buddy_reengage_day5', 'buddy_reengage_day14',
                     'pro_expiry_reminder', 'v2_launch', 'task_reminder',
                     'weekly_summary', 'follow_through', 'routine_streak']) {
      expect(isMarketingTemplate(t)).toBe(true);
    }
  });

  test('transactional templates are NEVER suppressed', () => {
    for (const t of ['welcome', 'password_reset', 'password_reset_google',
                     'account_deletion', 'unsubscribe_confirmation', 'pro_welcome', null, undefined]) {
      expect(isMarketingTemplate(t)).toBe(false);
    }
  });
});

describe('normalizeEmail', () => {
  test('lowercases and trims', () => {
    expect(normalizeEmail('  Sean.Hendler@GMAIL.com ')).toBe('sean.hendler@gmail.com');
    expect(normalizeEmail(null)).toBe('');
  });
});
