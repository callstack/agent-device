import fs from 'node:fs';
import path from 'node:path';
import {
  TEST_RUN_TMP_PREFIX,
  TEST_RUN_TMP_ROOT,
  pruneAbandonedRunDirectories,
  reportPrunedRunDirectories,
  reportStoppedRunDirectoryConsumers,
  stopRunDirectoryConsumers,
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

// setup/teardown are vitest's globalSetup contract: it imports this file by
// the path string in vitest.config.ts and calls these by name, so nothing in
// the source graph references them directly.
// fallow-ignore-next-line unused-export
export function setup(): void {
  previousTmpDir = process.env.TMPDIR;
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
export async function teardown(): Promise<void> {
  try {
    reportStoppedRunDirectoryConsumers(
      testRunTmpDir,
      await stopRunDirectoryConsumers(testRunTmpDir),
    );
  } finally {
    fs.rmSync(testRunTmpDir, { recursive: true, force: true });
    restoreEnv('TMPDIR', previousTmpDir);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
