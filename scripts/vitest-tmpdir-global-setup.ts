import fs from 'node:fs';
import path from 'node:path';

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
// Rooted at /tmp rather than nested inside the current os.tmpdir(): macOS's
// per-user TMPDIR (/var/folders/.../T/) is already close to the 104-byte
// sun_path limit AF_UNIX sockets need, and tests that bind real sockets
// (e.g. runner-usbmux.test.ts) started hitting EINVAL once nested one level
// deeper. /tmp is short enough to leave headroom for those.
//
// check-tmpdir-leaks.ts imports these two rather than recomputing them, so
// the two can't drift onto different directories (os.tmpdir() != /tmp on
// macOS, where TMPDIR is a deep per-user path).
export const TEST_RUN_TMP_ROOT = '/tmp';
export const TEST_RUN_TMP_PREFIX = 'agent-device-test-run-';

let testRunTmpDir: string;

// setup/teardown are vitest's globalSetup contract: it imports this file by
// the path string in vitest.config.ts and calls these by name, so nothing in
// the source graph references them directly.
// fallow-ignore-next-line unused-exports
export function setup(): void {
  // The pid is embedded so check-tmpdir-leaks.ts can tell a directory that's
  // still in active use (its vitest process is alive — a concurrent run in
  // another worktree, say) apart from one actually abandoned by a killed
  // process; the trailing mkdtemp suffix still guards against same-pid reuse.
  testRunTmpDir = fs.mkdtempSync(
    path.join(TEST_RUN_TMP_ROOT, `${TEST_RUN_TMP_PREFIX}${process.pid}-`),
  );
  process.env.TMPDIR = testRunTmpDir;
}

// fallow-ignore-next-line unused-exports
export function teardown(): void {
  fs.rmSync(testRunTmpDir, { recursive: true, force: true });
}
