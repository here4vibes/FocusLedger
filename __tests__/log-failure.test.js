const { logFailure } = require('../lib/log-failure');

describe('logFailure', () => {
  let spy;
  beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => spy.mockRestore());

  test('logs prefix, operation, message and context, and resolves to the fallback', async () => {
    const out = await Promise.reject(new Error('boom'))
      .catch(logFailure('[Auth]', 'seedStarterRoutine', { userId: 7 }, false));
    expect(out).toBe(false);
    expect(spy).toHaveBeenCalledWith('[Auth] seedStarterRoutine failed:', 'boom', '| userId:', 7);
  });

  test('without a fallback resolves to undefined and still logs', async () => {
    const out = await Promise.reject(new Error('nope')).catch(logFailure('[push]', 'deletePushToken'));
    expect(out).toBeUndefined();
    expect(spy).toHaveBeenCalledWith('[push] deletePushToken failed:', 'nope');
  });

  test('handles non-Error rejections', async () => {
    await Promise.reject('plain').catch(logFailure('[x]', 'op', { a: 1 }));
    expect(spy).toHaveBeenCalledWith('[x] op failed:', 'plain', '| a:', 1);
  });
});
