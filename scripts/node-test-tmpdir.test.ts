import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../src/utils/exec.ts';
import { TEST_RUN_TMP_PREFIX, TEST_RUN_TMP_ROOT } from './vitest-tmpdir-global-setup.ts';

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
