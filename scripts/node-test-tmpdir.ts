// Redirects TMPDIR to a disposable, pid-tagged directory for the duration of
// a `node --test` invocation, then removes it — the `node --test` analogue
// of scripts/vitest-tmpdir-global-setup.ts (#1595, follow-up to #1593).
//
// `node --test` has no global setup/teardown hook, so instead of a lifecycle
// callback this wraps the whole invocation as a child process: every argument
// after this script's own path is forwarded verbatim to a fresh `node`
// process (e.g. `--test test/integration/*.test.ts`), so a package.json
// script only needs this prepended to its existing `node --test ...`
// invocation:
//
//   node --experimental-strip-types scripts/node-test-tmpdir.ts --test foo.test.ts
//
// os.tmpdir() reads TMPDIR on every call, so this covers every mkdtemp call
// site the child (and anything it spawns) makes — test and production code
// alike — without touching any of them, exactly like the Vitest lane.
//
// Cleanup runs from the process 'exit' event rather than only a try/finally,
// so it fires for normal completion, a thrown error, AND a signal this
// process forwards to a still-running child (Ctrl-C locally, or a CI job
// cancellation): the signal handlers below call `process.exit()`, which
// triggers 'exit' synchronously before the process actually terminates.
// Only a SIGKILL against this wrapper itself bypasses all of that — the same
// residual case check-tmpdir-leaks-model.ts already tolerates via its
// pid-liveness check, since it shares this directory's root and prefix.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdBackground } from '../src/utils/exec.ts';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './vitest-tmpdir-global-setup.ts';

const forwardedArgs = process.argv.slice(2);
if (forwardedArgs.length === 0) {
  throw new Error(
    'Usage: node scripts/node-test-tmpdir.ts <node args...> (e.g. --test foo.test.ts)',
  );
}

const testRunTmpDir = fs.mkdtempSync(
  path.join(TEST_RUN_TMP_ROOT, `${TEST_RUN_TMP_PREFIX}${process.pid}-`),
);

const childEnv = { ...process.env, TMPDIR: testRunTmpDir };

// Mirrors vitest-tmpdir-global-setup.ts's own carve-out: the Swift compiler
// cache is intentionally durable across runs (rebuilding it recompiles
// AVFoundation helpers and can push integration scenarios past their
// budgets), so it must NOT follow TMPDIR into the disposable run directory
// that gets removed after every invocation. Read os.tmpdir() before the
// TMPDIR override above takes effect in the child, so this resolves the same
// real per-user temp root vitest's globalSetup uses — the two lanes share
// one cache instead of each discarding and recompiling their own.
if (!childEnv.AGENT_DEVICE_SWIFT_CACHE_DIR?.trim()) {
  childEnv.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(os.tmpdir(), 'agent-device-swift-cache');
}

// This wrapper is itself a node:test file's own subprocess whenever
// node --test runs it directly (NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID: set by
// node's test runner on every test-file child), and node --test treats
// seeing those vars already set as a sign the child call is a recursive
// self-invocation — it prints a warning and skips running any files
// (verified: node --test would otherwise silently exit 0 without running the
// forwarded test file, a false pass). Since this wrapper's whole point is to
// spawn a fresh `node --test`, clear them so the child always actually runs.
delete childEnv.NODE_TEST_CONTEXT;
delete childEnv.NODE_TEST_WORKER_ID;

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  fs.rmSync(testRunTmpDir, { recursive: true, force: true });
}
// Synchronous last-resort net: fires on every exit path, including ones a
// try/finally around the await below would never reach (process.exit() calls
// from the signal handlers, an uncaught exception's default handler, ...).
process.on('exit', cleanup);

const { child, wait } = runCmdBackground(process.execPath, forwardedArgs, {
  env: childEnv,
  stdio: 'inherit',
  captureOutput: false,
  allowFailure: true,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(signal);
    // 128 + signal number is the shell convention for a signal-terminated exit.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

const result = await wait;
process.exitCode = result.exitCode;
