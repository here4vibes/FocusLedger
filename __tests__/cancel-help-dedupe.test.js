'use strict';

const { titleKey, findDuplicate } = require('../lib/task-dedupe');
const { cancelHelp, generalSteps, CONTACT_RE } = require('../lib/cancel-help');
const { dispatch } = require('../lib/agent-tools');

describe('task dedupe', () => {
  test('rewordings of the same cancel task match', () => {
    expect(titleKey('Cancel MySubaru subscription')).toBe(titleKey('Cancel MySubaru before it renews'));
    expect(findDuplicate('Cancel MySubaru subscription', [{ id: 9, title: 'Cancel MySubaru before it renews' }]).id).toBe(9);
  });
  test('real variants do not match', () => {
    expect(findDuplicate('Call mom back', [{ id: 1, title: 'Call mom' }])).toBeNull();
    expect(findDuplicate('Cancel Hulu', [{ id: 1, title: 'Cancel Netflix before it renews' }])).toBeNull();
  });
  test('a title of only filler words never matches', () => {
    expect(findDuplicate('my subscription', [{ id: 1, title: 'the plan' }])).toBeNull();
  });
});

describe('agent create_task refuses a duplicate', () => {
  test('points at the existing task and inserts nothing', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 42, title: 'Cancel MySubaru before it renews' }] }) };
    const out = await dispatch(pool, 7, 'create_task', { title: 'Cancel MySubaru subscription' });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ task_id: 42, duplicate: true });
    expect(out.receipt).toMatch(/Already on your list/);
    expect(out.undo).toBeNull();
    expect(pool.query.mock.calls.some(c => /INSERT INTO tasks/.test(c[0]))).toBe(false);
  });
  test('still creates a genuinely new task', async () => {
    // Answers by query: open tasks, the plan and cap checks (free, 1 open task), the insert.
    const pool = { query: jest.fn(async (sql) => {
      if (/SELECT id, title FROM tasks/.test(sql)) return { rows: [{ id: 42, title: 'Cancel MySubaru before it renews' }] };
      if (/SELECT admin_pro_override/.test(sql)) return { rows: [{ admin_pro_override: false }] };
      if (/COUNT\(\*\)::int AS c/.test(sql)) return { rows: [{ c: 1 }] };
      if (/INSERT INTO tasks/.test(sql)) return { rows: [{ id: 43, title: 'Call the dentist' }] };
      return { rows: [] };
    }) };
    const out = await dispatch(pool, 7, 'create_task', { title: 'Call the dentist' });
    expect(out.result.task_id).toBe(43);
    expect(out.undo).toEqual({ tool: 'create_task', task_id: 43 });
  });
});

describe('cancelHelp', () => {
  test('keeps model steps but strips contact details', async () => {
    const completeFn = async () => [
      '1. MySubaru is Subaru\'s connected-car service; open the MySubaru app.',
      '2. Call 1-800-SUBARU-3 to cancel.',
      '3. Go to account settings, then Subscriptions.',
      '- Visit www.mysubaru.com for help.',
      '4. Choose cancel and save the confirmation.',
    ].join('\n');
    const out = await cancelHelp('MySubaru', { completeFn });
    expect(out.source).toBe('ai');
    expect(out.steps).toHaveLength(3);
    expect(out.steps.join(' ')).not.toMatch(/800|www|\.com/);
    expect(out.steps[0]).toMatch(/^MySubaru is/);
    expect(out.search_url).toContain('how%20to%20cancel%20MySubaru');
  });
  test('falls back to general steps when the AI fails or is over budget', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await cancelHelp('MySubaru', { completeFn: async () => { throw new Error('quota'); } });
    expect(out.source).toBe('general');
    expect(out.steps).toEqual(generalSteps('MySubaru'));
    err.mockRestore();
  });
  test('falls back when filtering leaves too little', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await cancelHelp('Gym', { completeFn: async () => 'Call (555) 123-4567\nEmail help@gym.com\nOk' });
    expect(out.source).toBe('general');
    warn.mockRestore();
  });
  test('contact filter does not eat ordinary numbers', () => {
    expect(CONTACT_RE.test('Microsoft 365 renews yearly')).toBe(false);
    expect(CONTACT_RE.test('Cancel at least 3 days before renewal')).toBe(false);
  });
});
