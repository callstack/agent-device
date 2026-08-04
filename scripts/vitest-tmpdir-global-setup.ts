import fs from 'node:fs';
import path from 'node:path';

// os.tmpdir() reads TMPDIR on every call, so redirecting it here covers every
// mkdtemp call site — test and production — without touching any of them.
// globalSetup/globalTeardown run once per `vitest run` invocation, in the
// same process that spawns every worker, so this env mutation is inherited
// by all of them (confirmed: forked workers see it via normal env
// inheritance) and the removal below only ever runs once, after every worker
// across every project has finished.
//
// Rooted at /tmp rather than nested inside the current os.tmpdir(): macOS's
// per-user TMPDIR (/var/folders/.../T/) is already close to the 104-byte
// sun_path limit AF_UNIX sockets need, and tests that bind real sockets
// (e.g. runner-usbmux.test.ts) started hitting EINVAL once nested one level
// deeper. /tmp is short enough to leave headroom for those.
let testRunTmpDir: string;

export function setup(): void {
  testRunTmpDir = path.join('/tmp', `agent-device-test-run-${process.pid}`);
  fs.mkdirSync(testRunTmpDir, { recursive: true });
  process.env.TMPDIR = testRunTmpDir;
}

export function teardown(): void {
  fs.rmSync(testRunTmpDir, { recursive: true, force: true });
}
