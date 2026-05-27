/**
 * Mock pool factory for testing routes without a real database.
 *
 * Usage:
 *   const pool = mockPool([
 *     { rows: [{ id: 1, email: 'test@example.com' }], rowCount: 1 },
 *     { rows: [], rowCount: 0 },
 *   ]);
 *
 * Each call to pool.query() returns the next queued response.
 * If you need to inspect what was called: pool.query.mock.calls
 */
function mockPool(responses = []) {
  let callIndex = 0;
  const queryFn = jest.fn(async (sql, params) => {
    const resp = responses[callIndex];
    callIndex++;
    if (resp === undefined) {
      // Default empty response if not enough responses queued
      return { rows: [], rowCount: 0 };
    }
    if (resp instanceof Error) throw resp;
    return resp;
  });

  // mock client for transaction tests (pool.connect())
  const clientQueryFn = jest.fn(async (sql, params) => {
    const resp = responses[callIndex];
    callIndex++;
    if (resp === undefined) return { rows: [], rowCount: 0 };
    if (resp instanceof Error) throw resp;
    return resp;
  });

  const mockClient = {
    query: clientQueryFn,
    release: jest.fn()
  };

  return {
    query: queryFn,
    connect: jest.fn(async () => mockClient),
    _mockClient: mockClient,
    _getCallCount: () => callIndex,
  };
}

module.exports = { mockPool };
