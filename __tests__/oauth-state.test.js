const { signUserState, verifyUserState, MAX_AGE_MS } = require('../lib/oauth-state');

describe('signed OAuth state', () => {
  const saved = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('round-trips the user id', () => {
    expect(verifyUserState('gcal', signUserState('gcal', 42))).toBe(42);
  });

  test('rejects a forged state with another user id', () => {
    const forged = Buffer.from(JSON.stringify({ userId: 7 })).toString('base64url');
    expect(verifyUserState('gcal', forged)).toBeNull();
    const [, ts, sig] = Buffer.from(signUserState('gcal', 42), 'base64url').toString().split(':');
    expect(verifyUserState('gcal', Buffer.from(`7:${ts}:${sig}`).toString('base64url'))).toBeNull();
  });

  test('rejects a state minted for another flow or with another key', () => {
    expect(verifyUserState('gcal', signUserState('email', 42))).toBeNull();
    const state = signUserState('gcal', 42);
    process.env.JWT_SECRET = 'other-secret';
    expect(verifyUserState('gcal', state)).toBeNull();
  });

  test('rejects an expired state', () => {
    const state = signUserState('gcal', 42);
    expect(verifyUserState('gcal', state, Date.now() + MAX_AGE_MS + 1000)).toBeNull();
  });

  test('rejects malformed input', () => {
    for (const bad of [undefined, '', 'not-base64', Buffer.from('a:b:c').toString('base64url')]) {
      expect(verifyUserState('gcal', bad)).toBeNull();
    }
  });

  test('refuses to sign without a secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => signUserState('gcal', 42)).toThrow(/JWT_SECRET/);
  });
});
