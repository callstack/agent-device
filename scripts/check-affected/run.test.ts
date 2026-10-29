// Entrypoint regressions for `pnpm check:affected`: the model self-test covers
// classification, this covers the run.ts seams the model cannot — real git
// change discovery (committed/staged/unstaged/untracked + both rename paths)
// and `--run` propagation (order, GitHub-authoritative skips, stop-on-failure).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { STALE_NODE_MODULES_MESSAGE } from './lockfile-install-sync.ts';
import { beginStderrCapture } from '../../src/__tests__/test-utils/stream-capture.ts';
import { CHECK_CATALOG } from './checks.ts';
import { selectChecks } from './model.ts';
import { type CommandExecutor, readChangedFiles, runChecks } from './run.ts';

function git(cwd: string, ...args: string[]): void {
  runCmdSync('git', args, { cwd });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-affected-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

test('readChangedFiles surfaces committed, staged, unstaged, untracked, and both rename paths', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'committed.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, 'to-rename.ts'), 'export const b = 2;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    // Committed on top of base: an edit plus a rename (git records it as R100).
    fs.writeFileSync(path.join(dir, 'committed.ts'), 'export const a = 2;\n');
    git(dir, 'mv', 'to-rename.ts', 'renamed.ts');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'work');

    // Working-tree state the committed diff cannot see.
    fs.writeFileSync(path.join(dir, 'staged.ts'), 'export const c = 3;\n');
    git(dir, 'add', 'staged.ts');
    fs.writeFileSync(path.join(dir, 'committed.ts'), 'export const a = 3;\n'); // unstaged edit
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const d = 4;\n');

    const files = readChangedFiles(base, 'HEAD', dir);
    assert.ok(files.includes('committed.ts'));
    assert.ok(files.includes('to-rename.ts'), 'rename source path must be preserved');
    assert.ok(files.includes('renamed.ts'), 'rename destination path must be preserved');
    assert.ok(files.includes('staged.ts'), 'staged working-tree file must be included');
    assert.ok(files.includes('untracked.ts'), 'untracked file must be included');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readChangedFiles unions staged and unstaged so a net diff cannot hide a file', () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const s = 0;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    // Stage a new file, then delete it in the working tree. `git diff HEAD`
    // nets to nothing (absent in HEAD and in the working tree), so a net
    // comparison would drop config.ts entirely.
    fs.writeFileSync(path.join(dir, 'config.ts'), 'export const c = 1;\n');
    git(dir, 'add', 'config.ts');
    fs.rmSync(path.join(dir, 'config.ts'));

    assert.deepEqual(
      runCmdSync('git', ['diff', '--name-only', 'HEAD'], { cwd: dir })
        .stdout.split('\n')
        .filter(Boolean),
      [],
      'sanity: the net `git diff HEAD` really does hide config.ts',
    );
    assert.ok(
      readChangedFiles(base, 'HEAD', dir).includes('config.ts'),
      'staged add + unstaged delete must still surface config.ts',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('readChangedFiles excludes repository-owned host-local workspace roots', () => {
  const dir = makeRepo();
  try {
    fs.copyFileSync(path.join(repoRoot, '.gitignore'), path.join(dir, '.gitignore'));
    fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const seed = true;\n');
    git(dir, 'add', '.gitignore', 'seed.ts');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).stdout.trim();

    fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.worktrees', 'embedded-clone'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex', 'config.local.toml'), 'model = "local"\n');
    fs.writeFileSync(
      path.join(dir, '.worktrees', 'embedded-clone', 'package.json'),
      '{"private":true}\n',
    );
    fs.writeFileSync(path.join(dir, 'untracked.ts'), 'export const visible = true;\n');

    assert.deepEqual(readChangedFiles(base, 'HEAD', dir), ['untracked.ts']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real package scripts: a fixture map has to be hand-extended for every new
// gate, which is the drift the registry exists to remove.
const ALL_SCRIPTS: Record<string, string> = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

const ARGS = { base: 'origin/main', head: 'HEAD', json: false, run: true };

test('runChecks runs local checks in order and stops on the first failure', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return command.includes('lint') ? 1 : 0;
  };
  const plan = selectChecks({
    changedFiles: ['packages/selectors/src/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, { execute, cwd: '.' });
  assert.equal(code, 1);
  // format then lint, then it stops — nothing after the failing check runs.
  assert.deepEqual(
    executed.map((command) => command.at(-1)),
    ['format:check', 'lint'],
  );
});

async function runPassing(changedFiles: string[]): Promise<string[][]> {
  const executed: string[][] = [];
  const plan = selectChecks({ changedFiles, packageEntryFiles: [] });
  assert.equal(plan.failOpen, false, changedFiles.join(', '));
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute: async (command) => {
      executed.push(command);
      return 0;
    },
    cwd: '.',
    changedFiles,
  });
  assert.equal(code, 0);
  return executed;
}

const RELATED = ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests'];

// check:unit runs every unit-core and fuzz-worker test, so the related run must not repeat them.
test('a production source change leaves the unit projects to the unit suite it runs', async () => {
  const changedFiles = ['packages/selectors/src/index.ts', 'packages/selectors/src/index.test.ts'];
  const executed = await runPassing(changedFiles);
  assert.ok(executed.some((command) => command.includes('check:unit')));
  assert.deepEqual(
    executed.find((command) => command.includes('related')),
    [...RELATED, '--project=!unit-core', '--project=!fuzz-worker', ...changedFiles],
  );
});

test('a test-only change keeps the unit projects in the related run', async () => {
  const changedFiles = ['packages/daemon/src/selectors.test.ts'];
  const executed = await runPassing(changedFiles);
  assert.ok(!executed.some((command) => command.includes('check:unit')));
  assert.deepEqual(
    executed.find((command) => command.includes('related')),
    [...RELATED, ...changedFiles],
  );
});

test('runChecks skips CI checks, runs every local check of a fail-open plan, and preserves local ordering', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  // A fail-open plan selects every check, including the non-local build lanes.
  const plan = selectChecks({
    changedFiles: ['unknown/path.xyz'],
    packageEntryFiles: [],
  });
  assert.equal(plan.failOpen, true);
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, { execute, cwd: '.' });
  assert.equal(code, 0);
  const ran = executed.map((command) => command.at(-1));
  // Derived from the catalog rather than hand-listed. A hand-written name goes vacuous the
  // moment a check is repointed: this list still asserted `build:android-snapshot-helper`
  // after `android-helpers` moved to `build:android`, so it could not have failed however
  // the flag was set.
  const authoritative = CHECK_CATALOG.filter((spec) => !spec.localRunnable).flatMap((spec) =>
    spec.kind.type === 'script' ? [spec.kind.script] : [],
  );
  assert.ok(authoritative.length >= 10, 'the catalog must still mark CI-owned checks');
  for (const skipped of authoritative) {
    assert.ok(
      !ran.includes(skipped),
      `${skipped} is GitHub-authoritative and must not run locally`,
    );
  }
  const related = executed.filter((command) => command.includes('related'));
  assert.equal(related.length, 1);
  assert.ok(
    !related[0]?.some((arg) => arg.startsWith('--project')),
    'a fail-open related run keeps every Vitest project',
  );
  assert.ok(
    !related[0]?.includes('--coverage'),
    'coverage instrumentation stays GitHub-authoritative; the local run must not add it',
  );
  assert.equal(
    related[0]?.some((arg) => arg.startsWith('--maxWorkers=')),
    false,
    'worker sizing belongs to vitest.config.ts',
  );
  assert.ok(
    executed.findIndex((command) => command.includes('test:integration:node')) <
      executed.findIndex((command) => command.includes('related')),
    'process-lifecycle integration must run before the related-project workload',
  );
  assert.equal(
    executed.some((command) => command.includes('test:coverage')),
    false,
  );
  // A fail-open plan could not narrow the change, so the related run stands in for nothing.
  for (const script of ['check:unit', 'test:integration:provider']) {
    assert.ok(
      executed.some((command) => command.includes(script)),
      `${script} must run when the plan fails open`,
    );
  }
  assert.equal(
    executed.some((command) => command.includes('check:coverage-changed')),
    false,
    'the coverage gate is GitHub-authoritative and must not run locally',
  );
});

async function runFailingOn(script: string, changedFiles: string[]): Promise<number> {
  const plan = selectChecks({ changedFiles, packageEntryFiles: [] });
  assert.equal(plan.failOpen, false, changedFiles.join(', '));
  return await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute: async (command) => (command.includes(script) ? 23 : 0),
    cwd: '.',
    changedFiles,
  });
}

// The eager-closure budget and similar unit gates read sources as text, so no related test reaches
// them; a production change that only they reject must still fail the local run (#3995).
test('a production source change fails on a unit-suite failure the related run cannot see', async () => {
  for (const changedFiles of [
    ['src/cli.ts'],
    ['packages/selectors/src/index.ts'],
    ['packages/platform-apple/src/runner/runner-cache-metadata.ts'],
    ['packages/selectors/src/index.ts', 'contracts/fixtures/tap-point-policy.json'],
  ]) {
    assert.equal(await runFailingOn('check:unit', changedFiles), 23, changedFiles.join(', '));
  }
});

test('a test-only change leaves the full unit suite to CI', async () => {
  assert.equal(await runFailingOn('check:unit', ['packages/daemon/src/selectors.test.ts']), 0);
});

test('the related run still stands in for provider-integration on a narrowed plan', async () => {
  const changedFiles = ['packages/platform-apple/src/runner/runner-cache-metadata.ts'];
  const plan = selectChecks({ changedFiles, packageEntryFiles: [] });
  assert.equal(plan.failOpen, false);
  assert.ok(plan.checks.includes('provider-integration'));
  const executed: string[][] = [];
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute: async (command) => {
      executed.push(command);
      return 0;
    },
    cwd: '.',
    changedFiles,
  });
  assert.equal(code, 0);
  assert.ok(executed.some((command) => command.includes('related')));
  assert.ok(!executed.some((command) => command.includes('test:integration:provider')));
});

test('runChecks fails fast on a stale install before running format or any other check', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  const plan = selectChecks({
    changedFiles: ['packages/selectors/src/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute,
    cwd: '.',
    checkLockfileSync: () => ({ status: 'out-of-sync', reason: 'stale' }),
  });
  assert.equal(code, 1);
  assert.deepEqual(executed, [], 'no check — including format — may run against a stale install');
});

test('runChecks fails fast when node_modules was never installed in this checkout', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  const plan = selectChecks({
    changedFiles: ['packages/selectors/src/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute,
    cwd: '.',
    checkLockfileSync: () => ({ status: 'out-of-sync', reason: 'install-missing' }),
  });
  assert.equal(code, 1);
  assert.deepEqual(executed, []);
});

test('runChecks does not block when there is no source checkout to compare against', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  const plan = selectChecks({
    changedFiles: ['packages/selectors/src/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute,
    cwd: '.',
    checkLockfileSync: () => ({ status: 'no-source-checkout' }),
  });
  assert.equal(code, 0);
  assert.ok(executed.length > 0, 'checks still run when there is nothing to compare against');
});

test('runChecks proceeds normally when the install is in sync', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  const plan = selectChecks({
    changedFiles: ['packages/selectors/src/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute,
    cwd: '.',
    checkLockfileSync: () => ({ status: 'in-sync' }),
  });
  assert.equal(code, 0);
  assert.ok(executed.some((command) => command.includes('format:check')));
});

test('runChecks names the real cause on stderr instead of surfacing as an unrelated failure', async () => {
  const stderrCapture = beginStderrCapture();

  try {
    const plan = selectChecks({
      changedFiles: ['packages/selectors/src/index.ts'],
      packageEntryFiles: [],
    });
    const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
      execute: async () => 0,
      cwd: '.',
      checkLockfileSync: () => ({ status: 'out-of-sync', reason: 'stale' }),
    });
    assert.equal(code, 1);
    assert.ok(
      stderrCapture.read().includes(STALE_NODE_MODULES_MESSAGE),
      `expected stderr to name the stale-install cause, got: ${stderrCapture.read()}`,
    );
    const stderr = stderrCapture.read();
    assert.match(stderr, /Worktree: \.\n/);
    assert.match(stderr, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(stderr, /agent-device doctor/);
  } finally {
    stderrCapture.restore();
  }
});
