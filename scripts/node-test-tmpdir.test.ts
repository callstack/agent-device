import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd, runCmdBackground } from '../src/utils/exec.ts';
import {
  liveRunDirectoryConsumers,
  pruneAbandonedRunDirectories,
  TEST_RUN_TMP_PREFIX,
  TEST_RUN_TMP_ROOT,
} from './check-tmpdir-leaks-model.ts';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(REPOSITORY_ROOT, 'scripts', 'node-test-tmpdir.ts');

// package.json scripts that may legitimately invoke `node --test` without
// routing through the wrapper below. Empty on purpose: every current
// node --test lane is wrapped (#1595). Add a script name here only alongside
// a comment explaining why that lane can't be wrapped — the ratchet test
// below fails closed on anything else, so a 14th `node --test` script added
// later without the wrapper fails CI instead of silently leaking again.
const NODE_TEST_WRAPPER_BYPASS_ALLOWLIST = new Set<string>([]);

// Dumb string matching on purpose (no shell parsing, per the scripts map's
// own style: '&&'-chained commands, nothing fancier). True when a `node ...`
// segment enables the built-in test runner via a word-bounded `--test` flag
// and hasn't already been routed through the wrapper.
function isUnwrappedNodeTestSegment(segment: string): boolean {
  const trimmed = segment.trim();
  if (!/^node(\s|$)/.test(trimmed)) return false;
  if (trimmed.includes('node-test-tmpdir.ts')) return false;
  return /(^|\s)--test(\s|$)/.test(trimmed);
}

// Date.now() alone collides when this file's top-level tests happen to start
// within the same millisecond (observed in practice), which overwrites one
// probe's source with another's; the random suffix makes each probe path
// unique regardless of scheduling.
function writeProbe(evidencePath: string): string {
  const probeName = `node-test-tmpdir-probe-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('probe records its inherited TMPDIR', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, os.tmpdir());
});
`,
  );
  return probePath;
}

test('the wrapper redirects a node --test child TMPDIR and removes it after the run', async () => {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-lifecycle-test-'));
  const evidencePath = path.join(evidenceRoot, 'child-tmpdir.txt');
  const probePath = writeProbe(evidencePath);
  let childTmpDir: string | undefined;

  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000 },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);

    childTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.dirname(childTmpDir), TEST_RUN_TMP_ROOT);
    assert.match(path.basename(childTmpDir), new RegExp(`^${TEST_RUN_TMP_PREFIX}\\d+-`));
    assert.equal(
      fs.existsSync(childTmpDir),
      false,
      'the wrapper must remove the run directory after the child exits',
    );
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('the wrapper still cleans up and forwards a nonzero exit code when the child fails', async () => {
  // Diffing the whole shared TEST_RUN_TMP_ROOT listing is racy here: this
  // file itself runs as one of several node --test files/workers sharing
  // that root (e.g. alongside vitest-tmpdir-global-setup.test.ts in
  // check:tmpdir-leaks:test), any of which can create and remove their own
  // sibling run directory mid-diff. Recording the probe's actual TMPDIR (the
  // same technique as the test above) and checking only that one path avoids
  // the shared-directory race entirely.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-lifecycle-fail-'));
  const evidencePath = path.join(evidenceRoot, 'child-tmpdir.txt');
  const probeName = `node-test-tmpdir-probe-fail-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';

test('deliberately failing probe', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, os.tmpdir());
  assert.fail('intentional failure to verify exit-code forwarding');
});
`,
  );

  let childTmpDir: string | undefined;
  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000, allowFailure: true },
    );
    assert.notEqual(result.exitCode, 0, 'a failing child must propagate a nonzero exit code');

    childTmpDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.dirname(childTmpDir), TEST_RUN_TMP_ROOT);
    assert.match(path.basename(childTmpDir), new RegExp(`^${TEST_RUN_TMP_PREFIX}\\d+-`));
    assert.equal(fs.existsSync(childTmpDir), false, `wrapper left behind: ${childTmpDir}`);
  } finally {
    if (childTmpDir) fs.rmSync(childTmpDir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('the wrapper keeps AGENT_DEVICE_SWIFT_CACHE_DIR outside the disposable TMPDIR', async () => {
  // Mirrors vitest-tmpdir-global-setup.ts's own carve-out (and its test's
  // technique below): the Swift compiler cache must survive across runs, so
  // it must resolve outside whichever directory this invocation's TMPDIR
  // redirect will remove afterward. Passing '' forces the "unset" branch
  // regardless of what this test process itself inherited.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-swift-cache-'));
  const evidencePath = path.join(evidenceRoot, 'swift-cache-dir.txt');
  const probeName = `node-test-tmpdir-probe-swift-cache-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import { test } from 'node:test';

test('probe records its inherited AGENT_DEVICE_SWIFT_CACHE_DIR', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, process.env.AGENT_DEVICE_SWIFT_CACHE_DIR ?? '');
});
`,
  );

  // Computed the same way the wrapper computes it: from THIS process's
  // os.tmpdir(), before the child's TMPDIR gets redirected. If this file is
  // itself already running nested inside another wrapper's redirect (e.g.
  // as part of check:tmpdir-leaks:test), that's the correct anchor too — the
  // cache chains to whichever temp scope was current right before this
  // specific invocation, exactly like vitest's setup() would if nested the
  // same way.
  const expectedCacheDir = path.join(os.tmpdir(), 'agent-device-swift-cache');

  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      {
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
        env: { ...process.env, AGENT_DEVICE_SWIFT_CACHE_DIR: '' },
      },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);

    const cacheDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(
      cacheDir,
      expectedCacheDir,
      'the wrapper must set AGENT_DEVICE_SWIFT_CACHE_DIR from the pre-redirect os.tmpdir(), ' +
        'not leave it to default inside the disposable TMPDIR it is about to remove',
    );
  } finally {
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('the wrapper isolates advisory device claims inside its disposable run directory', async () => {
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-claims-dir-'));
  const evidencePath = path.join(evidenceRoot, 'claims-dir.txt');
  const probeName = `node-test-claims-dir-probe-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import { test } from 'node:test';

test('probe records its inherited AGENT_DEVICE_CLAIMS_DIR', () => {
  fs.writeFileSync(${JSON.stringify(evidencePath)}, process.env.AGENT_DEVICE_CLAIMS_DIR ?? '');
});
`,
  );

  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      {
        cwd: REPOSITORY_ROOT,
        timeoutMs: 30_000,
        env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: '/host/device-claims' },
      },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);

    const claimsDir = fs.readFileSync(evidencePath, 'utf8');
    assert.equal(path.basename(claimsDir), 'device-claims');
    assert.equal(
      fs.existsSync(path.dirname(claimsDir)),
      false,
      'the claims directory must be removed with the wrapper-owned run directory',
    );
    assert.notEqual(claimsDir, '/host/device-claims');
  } finally {
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

// The 13 lanes wrapped in package.json when this fix landed were a one-time
// hand sweep; nothing stopped a 14th `node --test` script from being added
// later without the wrapper, silently reopening #1595 for that one lane.
// This turns the sweep into an invariant instead.
test('every node --test package.json script routes through scripts/node-test-tmpdir.ts', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, string>;
  };
  const scripts = manifest.scripts ?? {};

  const unwrapped = Object.entries(scripts)
    .filter(([name]) => !NODE_TEST_WRAPPER_BYPASS_ALLOWLIST.has(name))
    .filter(([, command]) => command.split('&&').some(isUnwrappedNodeTestSegment))
    .map(([name]) => name);

  assert.deepEqual(
    unwrapped,
    [],
    `these package.json scripts invoke \`node --test\` directly instead of through ` +
      `scripts/node-test-tmpdir.ts, so a crash/timeout kill during their run leaks a scratch ` +
      `directory again: ${unwrapped.join(', ')}. Route them through the wrapper, or add to ` +
      `NODE_TEST_WRAPPER_BYPASS_ALLOWLIST above with a reason if one must legitimately bypass it.`,
  );
});

// INT32_MAX exceeds every platform's pid range (Linux pid_max caps at 2^22,
// macOS at 99999), so kill(pid, 0) is ESRCH by construction — an owner that
// is dead and can never be reused mid-test, unlike a freshly exited child's pid.
const NEVER_A_PID = 2_147_483_647;

test('the wrapper prunes a run directory abandoned by an earlier killed run and keeps a live one', async () => {
  const stamp = crypto.randomUUID();
  const abandoned = path.join(
    TEST_RUN_TMP_ROOT,
    `${TEST_RUN_TMP_PREFIX}${NEVER_A_PID}-planted-${stamp}`,
  );
  const live = path.join(
    TEST_RUN_TMP_ROOT,
    `${TEST_RUN_TMP_PREFIX}${process.pid}-planted-${stamp}`,
  );
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-prune-'));
  const probePath = writeProbe(path.join(evidenceRoot, 'child-tmpdir.txt'));
  fs.mkdirSync(path.join(abandoned, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(abandoned, 'nested', 'leftover.txt'), 'from a killed run');
  fs.mkdirSync(live);

  try {
    const result = await runCmd(
      process.execPath,
      ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
      { cwd: REPOSITORY_ROOT, timeoutMs: 30_000 },
    );
    assert.equal(result.exitCode, 0, `probe run failed:\n${result.stdout}\n${result.stderr}`);
    assert.equal(
      fs.existsSync(abandoned),
      false,
      'the wrapper must prune the abandoned run directory',
    );
    assert.equal(
      fs.existsSync(live),
      true,
      'the wrapper must never touch a live owner’s run directory',
    );
  } finally {
    fs.rmSync(abandoned, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

test('a run whose owner alone was killed keeps its directory while a child still uses it, and loses it once the child exits', async () => {
  // The motivating case for consumer-aware pruning: a tool timeout SIGKILLs the wrapper (the
  // owner pid in the directory name) while something it started — here a detached child the
  // probe spawned, the shape of a daemon a test brought up — is still running with TMPDIR
  // pointing into the run directory. Owner-pid liveness alone would prune the directory out
  // from under that child on the next run.
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-tmpdir-orphan-'));
  const evidencePath = path.join(evidenceRoot, 'evidence.json');
  const readyPath = path.join(evidenceRoot, 'ready');
  const probeName = `node-test-tmpdir-probe-orphan-${process.pid}-${crypto.randomUUID()}.test.ts`;
  const probePath = path.join(REPOSITORY_ROOT, 'scripts', probeName);
  fs.writeFileSync(
    probePath,
    `import fs from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { runCmdDetached } from '../src/utils/exec.ts';

test('probe starts a long-lived detached child that inherits TMPDIR, then waits to be killed', async () => {
  const childPid = runCmdDetached(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  fs.writeFileSync(
    ${JSON.stringify(evidencePath)},
    JSON.stringify({ tmpdir: os.tmpdir(), childPid, probePid: process.pid, runnerPid: process.ppid }),
  );
  fs.writeFileSync(${JSON.stringify(readyPath)}, '');
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
`,
  );

  let evidence:
    | { tmpdir: string; childPid: number; probePid: number; runnerPid: number }
    | undefined;
  const consumersOf = (e: NonNullable<typeof evidence>) => [e.childPid, e.probePid, e.runnerPid];
  const wrapper = runCmdBackground(
    process.execPath,
    ['--experimental-strip-types', WRAPPER, '--experimental-strip-types', '--test', probePath],
    { cwd: REPOSITORY_ROOT, captureOutput: false, stdio: 'ignore', allowFailure: true },
  );
  try {
    await waitFor(() => fs.existsSync(readyPath), 20_000, 'probe never reported ready');
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const runDir = evidence!.tmpdir;
    assert.equal(path.dirname(runDir), TEST_RUN_TMP_ROOT);
    assert.equal(isAlive(evidence!.childPid), true, 'the detached child must be running');

    // Kill only the owner. Its exit handler cannot run on SIGKILL, so the directory survives it.
    process.kill(wrapper.child.pid!, 'SIGKILL');
    await wrapper.wait;
    assert.equal(fs.existsSync(runDir), true, 'SIGKILL of the owner leaves the directory behind');
    assert.equal(isAlive(evidence!.childPid), true, 'the detached child outlives its owner');

    // The next run's prune must see the child holding TMPDIR and leave the directory alone.
    assert.deepEqual(
      pruneAbandonedRunDirectories(TEST_RUN_TMP_ROOT).filter((name) => runDir.endsWith(name)),
      [],
    );
    assert.equal(fs.existsSync(runDir), true, 'a directory with a live consumer is not pruned');
    assert.equal(fs.existsSync(path.join(runDir)), true);

    // Once every consumer is gone — the detached child AND the orphaned node --test chain,
    // which holds the same TMPDIR — it is an ordinary abandoned directory.
    for (const pid of consumersOf(evidence!)) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    await waitFor(
      () => !liveRunDirectoryConsumers().has(path.basename(runDir)),
      20_000,
      'the run directory still shows a live consumer after every child exited',
    );
    assert.deepEqual(
      pruneAbandonedRunDirectories(TEST_RUN_TMP_ROOT).filter((name) => runDir.endsWith(name)),
      [path.basename(runDir)],
    );
    assert.equal(fs.existsSync(runDir), false, 'with no owner and no consumer it is pruned');
  } finally {
    for (const pid of evidence ? consumersOf(evidence) : []) {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
    if (wrapper.child.exitCode === null && wrapper.child.signalCode === null) {
      wrapper.child.kill('SIGKILL');
    }
    if (evidence) fs.rmSync(evidence.tmpdir, { recursive: true, force: true });
    fs.rmSync(probePath, { force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
