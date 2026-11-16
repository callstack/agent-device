import { installWorkspaceMaestro } from './install-workspace-maestro.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  liveRunDirectoryConsumers,
  TEST_RUN_TMP_PREFIX,
  TEST_RUN_TMP_ROOT,
  pruneAbandonedRunDirectories,
  reportPrunedRunDirectories,
  reportStoppedRunDirectoryConsumers,
  stopRunDirectoryConsumers,
  sweepUnsharedRunDirectories,
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

let testRunTmpDir: string | undefined;
let previousTmpDir: string | undefined;
let unsharedRunDir: string | undefined;
let previousUnsharedDir: string | undefined;
let previousUnsharedUnavailable: string | undefined;
let previousPluginHome: string | undefined;

// State that a sticky shared directory such as /tmp must not hold, the Swift helper cache's among them, lives
// in the checkout's ignored .tmp/ instead. Each run gets its own directory there, named like its TMPDIR one,
// so the same liveness rule prunes what a killed run abandoned.
const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Named per uid, so in a shared checkout another user's runs never share the root.
const UNSHARED_TEST_ROOT = path.join(
  CHECKOUT_ROOT,
  '.tmp',
  `unshared-test-dirs-${process.getuid?.() ?? 'user'}`,
);

// setup/teardown are vitest's globalSetup contract: it imports this file by
// the path string in vitest.config.ts and calls these by name, so nothing in
// the source graph references them directly.
// fallow-ignore-next-line unused-export
export function setup(): void {
  previousTmpDir = process.env.TMPDIR;
  previousUnsharedDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR;
  previousUnsharedUnavailable = process.env.AGENT_DEVICE_TEST_UNSHARED_UNAVAILABLE;
  const consumers = liveRunDirectoryConsumers();
  reportPrunedRunDirectories(pruneAbandonedRunDirectories(TEST_RUN_TMP_ROOT, { consumers }));
  const unshared = sweepUnsharedRunDirectories(CHECKOUT_ROOT, UNSHARED_TEST_ROOT, { consumers });
  if (unshared.swept) reportPrunedRunDirectories(unshared.pruned);
  else {
    // Only the tests that need the directory answer for its absence, with this reason: the rest of the run is
    // unaffected, whatever the checkout's layout.
    console.warn(`Skipping the checkout-local test directory sweep: ${unshared.reason}`);
    process.env.AGENT_DEVICE_TEST_UNSHARED_UNAVAILABLE = unshared.reason;
  }
  // The pid is embedded so check-tmpdir-leaks.ts can tell a directory that's
  // still in active use (its vitest process is alive — a concurrent run in
  // another worktree, say) apart from one actually abandoned by a killed
  // process; the trailing mkdtemp suffix still guards against same-pid reuse.
  testRunTmpDir = fs.mkdtempSync(
    path.join(TEST_RUN_TMP_ROOT, `${TEST_RUN_TMP_PREFIX}${process.pid}-`),
  );
  process.env.TMPDIR = testRunTmpDir;
  if (unshared.swept) {
    unsharedRunDir = path.join(UNSHARED_TEST_ROOT, path.basename(testRunTmpDir));
    fs.mkdirSync(unsharedRunDir, { mode: 0o700 });
    process.env.AGENT_DEVICE_TEST_UNSHARED_DIR = unsharedRunDir;
  }
  previousPluginHome = process.env.AGENT_DEVICE_HOME;
  process.env.AGENT_DEVICE_HOME = path.join(testRunTmpDir, 'plugin-home');
  installWorkspaceMaestro(process.env, true);
}

// fallow-ignore-next-line unused-export
export async function teardown(): Promise<void> {
  try {
    // A setup that failed part-way never made the run directory: teardown must not bury that failure.
    if (testRunTmpDir) {
      reportStoppedRunDirectoryConsumers(
        testRunTmpDir,
        await stopRunDirectoryConsumers(testRunTmpDir),
      );
    }
  } finally {
    if (previousPluginHome === undefined) delete process.env.AGENT_DEVICE_HOME;
    else process.env.AGENT_DEVICE_HOME = previousPluginHome;
    if (testRunTmpDir) fs.rmSync(testRunTmpDir, { recursive: true, force: true });
    if (unsharedRunDir) fs.rmSync(unsharedRunDir, { recursive: true, force: true });
    restoreEnv('TMPDIR', previousTmpDir);
    restoreEnv('AGENT_DEVICE_TEST_UNSHARED_DIR', previousUnsharedDir);
    restoreEnv('AGENT_DEVICE_TEST_UNSHARED_UNAVAILABLE', previousUnsharedUnavailable);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
