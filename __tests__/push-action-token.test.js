const tok = require('../lib/push-action-token');

describe('push action tokens', () => {
  const saved = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('round-trips user and task', () => {
    const t = tok.createTaskDoneToken(2, 41);
    expect(tok.verifyTaskDoneToken(t)).toEqual({ userId: 2, taskId: 41 });
  });

  test('rejects tampered, foreign-key and expired tokens', () => {
    const t = tok.createTaskDoneToken(2, 41);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ a: 'task_done', u: 3, t: 41, exp: 9999999999 })).toString('base64url');
    expect(tok.verifyTaskDoneToken(forged + '.' + sig)).toBeNull();
    expect(tok.verifyTaskDoneToken(body + '.x' + sig.slice(2))).toBeNull();
    process.env.JWT_SECRET = 'other';
    expect(tok.verifyTaskDoneToken(t)).toBeNull();
    process.env.JWT_SECRET = 'test-secret';
    const old = tok.createTaskDoneToken(2, 41, Date.now() - (tok.TTL_SECONDS + 60) * 1000);
    expect(tok.verifyTaskDoneToken(old)).toBeNull();
    expect(tok.verifyTaskDoneToken('nope')).toBeNull();
    expect(tok.verifyTaskDoneToken(undefined)).toBeNull();
  });

  test('without a signing key there is no Done button, only the opener', () => {
    delete process.env.JWT_SECRET;
    const a = tok.singleTaskActions(2, 41, { action: 'focus', title: 'Start focus', url: '/app/focus/41' });
    expect(a.actions).toEqual([{ action: 'focus', title: 'Start focus' }]);
    expect(a.actionTokens).toEqual({});
  });

  test('with a key: Done first, then the opener', () => {
    const a = tok.singleTaskActions(2, 41, { action: 'focus', title: 'Start focus', url: '/app/focus/41' });
    expect(a.actions.map(x => x.action)).toEqual(['done', 'focus']);
    expect(tok.verifyTaskDoneToken(a.actionTokens.done)).toEqual({ userId: 2, taskId: 41 });
    expect(a.actionUrls).toEqual({ focus: '/app/focus/41' });
  });
});
