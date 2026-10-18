'use strict';
/**
 * ci-harness.js — shared by the CI scripts that drive a real server
 * (ci-api-sweep.js, ci-write-flows.js): boot server.js, capture its log lines,
 * and spot the lines that mean code met the schema and lost.
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BOOT_TIMEOUT_MS = 45000;

// Logged lines that mean real code met a real schema and lost.
const ERROR_PATTERNS = [
  /does not exist/,               // column / relation / operator / function
  /invalid input syntax/,         // wrong type bound to a parameter
  /violates .* constraint/,
  /no unique or exclusion constraint/, // ON CONFLICT target without a unique index
  /syntax error at or near/,      // malformed SQL built at runtime
  /inconsistent types deduced/,   // one parameter bound as two types
  /TypeError/,
  /ReferenceError/,
  /Cannot read propert(y|ies)/,
  /is not a function/,
];

// Expected in a bare local/CI env, not bugs. Keep this short and give a reason.
const ALLOWLIST = [
  // No ANTHROPIC_API_KEY in CI: the SDK refuses to build a request.
  { pattern: /Could not resolve authentication method/, reason: 'no AI API key in CI' },
  { pattern: /ANTHROPIC_API_KEY|api[_ ]?key (is )?(missing|not set|not configured)/i, reason: 'no AI API key in CI' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function requireEnv(prefix) {
  for (const name of ['DATABASE_URL', 'JWT_SECRET']) {
    if (!process.env[name]) {
      console.error(`[${prefix}] FATAL: ${name} is required`);
      process.exit(1);
    }
  }
}

/**
 * Start server.js on `port`. Returns { child, base, drainLogs(), stop() };
 * drainLogs() returns and clears the lines logged since the last call.
 */
async function startServer(port) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ALLOWED_ORIGIN: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logBuf = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (buf) => logBuf.push(...buf.toString().split('\n').filter(Boolean)));
  }
  const stop = async () => {
    child.kill('SIGTERM');
    await sleep(500);
    if (child.exitCode === null) child.kill('SIGKILL');
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server did not become reachable within ${BOOT_TIMEOUT_MS}ms`);
    }
    try {
      const res = await fetch(base + '/health');
      if (res.status === 200 || res.status === 503) break;
    } catch { /* silent-ok: server not listening yet; the loop retries */ }
    await sleep(500);
  }
  return {
    child,
    base,
    drainLogs() { const out = logBuf; logBuf = []; return out; },
    stop,
  };
}

function unexplainedErrors(lines) {
  return lines.filter(line =>
    ERROR_PATTERNS.some(p => p.test(line)) && !ALLOWLIST.some(a => a.pattern.test(line)));
}

module.exports = { ROOT, ERROR_PATTERNS, ALLOWLIST, sleep, requireEnv, startServer, unexplainedErrors };
