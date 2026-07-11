// Entrypoint regressions for `pnpm check:affected`: the model self-test covers
// classification, this covers the run.ts seams the model cannot — real git
// change discovery (committed/staged/unstaged/untracked + both rename paths)
// and `--run` propagation (order, GitHub-authoritative skips, stop-on-failure).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '../../src/utils/exec.ts';
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

const ALL_SCRIPTS: Record<string, string> = {
  'format:check': 'x',
  lint: 'x',
  typecheck: 'x',
  'check:layering': 'x',
  'check:fallow': 'x',
  'check:mcp-metadata': 'x',
  build: 'x',
  'check:unit': 'x',
  'test:coverage': 'x',
  'test:integration:provider': 'x',
  'test:integration:node': 'x',
  'test:integration:progress:check': 'x',
  'test:skillgym': 'x',
};

const ARGS = { base: 'origin/main', head: 'HEAD', json: false, run: true };

test('runChecks runs local checks in order and stops on the first failure', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return command.includes('lint') ? 1 : 0;
  };
  const plan = selectChecks({
    changedFiles: ['src/selectors/index.ts'],
    packageEntryFiles: [],
  });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, { execute, cwd: '.' });
  assert.equal(code, 1);
  // format then lint, then it stops — nothing after the failing check runs.
  assert.deepEqual(
    executed.map((command) => command[command.length - 1]),
    ['format:check', 'lint'],
  );
});

test('runChecks passes the selector change set to Vitest related', async () => {
  const executed: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    executed.push(command);
    return 0;
  };
  const changedFiles = ['src/selectors/index.ts', 'src/selectors/index.test.ts'];
  const plan = selectChecks({ changedFiles, packageEntryFiles: [] });
  const code = await runChecks(plan, { scripts: ALL_SCRIPTS }, ARGS, {
    execute,
    cwd: '.',
    changedFiles,
  });
  assert.equal(code, 0);
  assert.deepEqual(
    executed.find((command) => command.includes('related')),
    ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', ...changedFiles],
  );
});

test('runChecks skips GitHub-authoritative checks and passes when locals succeed', async () => {
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
  const ran = executed.map((command) => command[command.length - 1]);
  for (const skipped of ['build:xcuitest', 'build:android-snapshot-helper', 'test:smoke:web']) {
    assert.ok(
      !ran.includes(skipped),
      `${skipped} is GitHub-authoritative and must not run locally`,
    );
  }
});
