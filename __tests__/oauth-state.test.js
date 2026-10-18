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

describe('verifyUserState without a secret', () => {
  const saved = process.env.JWT_SECRET;
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('rejects instead of throwing (no fallback secret)', () => {
    process.env.JWT_SECRET = 'test-secret';
    const state = signUserState('email-gmail', 42);
    delete process.env.JWT_SECRET;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(verifyUserState('email-gmail', state)).toBeNull();
    spy.mockRestore();
  });
});

describe('email connect purposes are distinct', () => {
  const saved = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('a Gmail state does not open Outlook, Yahoo or Calendar', () => {
    const state = signUserState('email-gmail', 42);
    expect(verifyUserState('email-gmail', state)).toBe(42);
    for (const other of ['email-outlook', 'email-yahoo', 'gcal']) expect(verifyUserState(other, state)).toBeNull();
  });
});

describe('signed payload state (Google sign-in)', () => {
  const { signPayload, verifyPayload } = require('../lib/oauth-state');
  const saved = process.env.JWT_SECRET;
  beforeEach(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('round-trips the object', () => {
    const d = { returnTo: 'signup', host: 'focusledger.net' };
    expect(verifyPayload('google-signin', signPayload('google-signin', d))).toEqual(d);
  });

  test('rejects a tampered body, another purpose, another key or an expired state', () => {
    const state = signPayload('google-signin', { returnTo: 'login', host: 'focusledger.net' });
    const [, sig] = state.split('.');
    const evil = Buffer.from(JSON.stringify({ d: { returnTo: 'login', host: 'evil.example' }, ts: Date.now() })).toString('base64url');
    expect(verifyPayload('google-signin', `${evil}.${sig}`)).toBeNull();
    expect(verifyPayload('other', state)).toBeNull();
    expect(verifyPayload('google-signin', state, Date.now() + MAX_AGE_MS + 1000)).toBeNull();
    process.env.JWT_SECRET = 'other-secret';
    expect(verifyPayload('google-signin', state)).toBeNull();
  });

  test('rejects malformed input', () => {
    for (const bad of [undefined, '', 'abc', 'a.b.c', '.', 'x.' + 'f'.repeat(64)]) {
      expect(verifyPayload('google-signin', bad)).toBeNull();
    }
  });

  test('refuses to sign without a secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => signPayload('google-signin', {})).toThrow(/JWT_SECRET/);
  });
});
