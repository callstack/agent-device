import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TEST_RUN_TMP_PREFIX,
  TEST_RUN_TMP_ROOT,
  pruneAbandonedRunDirectories,
  reportPrunedRunDirectories,
} from './check-tmpdir-leaks-model.ts';

// os.tmpdir() reads TMPDIR on every call, so redirecting it here covers every
// mkdtemp call site — test and production — without touching any of them.
// globalSetup/globalTeardown run once per `vitest run` invocation, in the
// same process that spawns every worker, so this env mutation is inherited
// by all of them (confirmed: forked workers see it via normal env
// inheritance) and the removal below only ever runs once, after every worker
// across every project has finished. A per-file afterAll hook was tried
// first; it proved unreliable (some workers were torn down before running
// it), which is why this is a single run-level hook instead.
//
// The root/prefix live in check-tmpdir-leaks-model.ts, next to the liveness
// classification this setup and the post-run leak check both rely on.

let testRunTmpDir: string;
let previousTmpDir: string | undefined;
let previousSwiftCacheDir: string | undefined;

// setup/teardown are vitest's globalSetup contract: it imports this file by
// the path string in vitest.config.ts and calls these by name, so nothing in
// the source graph references them directly.
// fallow-ignore-next-line unused-export
export function setup(): void {
  previousTmpDir = process.env.TMPDIR;
  previousSwiftCacheDir = process.env.AGENT_DEVICE_SWIFT_CACHE_DIR;
  const originalTmpDir = os.tmpdir();
  if (!previousSwiftCacheDir?.trim()) {
    // The Swift compiler cache is intentionally durable across test runs. If it
    // followed the disposable TMPDIR, AVFoundation helpers would recompile on
    // every invocation and push integration scenarios past their 5s budgets.
    process.env.AGENT_DEVICE_SWIFT_CACHE_DIR = path.join(
      originalTmpDir,
      'agent-device-swift-cache',
    );
  }
  reportPrunedRunDirectories(pruneAbandonedRunDirectories(TEST_RUN_TMP_ROOT));
  // The pid is embedded so check-tmpdir-leaks.ts can tell a directory that's
  // still in active use (its vitest process is alive — a concurrent run in
  // another worktree, say) apart from one actually abandoned by a killed
  // process; the trailing mkdtemp suffix still guards against same-pid reuse.
  testRunTmpDir = fs.mkdtempSync(
    path.join(TEST_RUN_TMP_ROOT, `${TEST_RUN_TMP_PREFIX}${process.pid}-`),
  );
  process.env.TMPDIR = testRunTmpDir;
}

// fallow-ignore-next-line unused-export
export function teardown(): void {
  fs.rmSync(testRunTmpDir, { recursive: true, force: true });
  restoreEnv('TMPDIR', previousTmpDir);
  restoreEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', previousSwiftCacheDir);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
