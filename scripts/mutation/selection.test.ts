// Selection is what the PR lane spends money on, so both halves of the rule are
// asserted end to end through the real CLI: a kernel diff selects nothing (the
// weekly sweep is the kernel report), and a lane-tooling diff selects real
// mutants rather than an empty matrix that proves nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { LANE_CANARY, shardMatrix, type ShardSpec } from './modules.ts';
import { affectedMatrixFor } from './run.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const worktrees: string[] = [];

after(() => {
  for (const dir of worktrees) {
    runCmdSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot });
  }
});

/**
 * A throwaway worktree holding one commit that touches only the given files, so
 * `--list-affected` runs against a real `git diff` rather than a stubbed list.
 */
function worktreeWithCommit(name: string, files: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mutation-${name}-`));
  fs.rmSync(dir, { recursive: true });
  runCmdSync('git', ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD'], { cwd: repoRoot });
  worktrees.push(dir);
  for (const file of files) {
    fs.appendFileSync(path.join(dir, file), '\n');
  }
  runCmdSync('git', ['add', ...files], { cwd: dir });
  // CI runners have no committer identity configured, and this commit is a
  // fixture, so it carries its own rather than depending on the environment.
  runCmdSync(
    'git',
    [
      '-c',
      'user.name=mutation-selection-test',
      '-c',
      'user.email=mutation-selection-test@invalid',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      `touch ${name}`,
    ],
    { cwd: dir },
  );
  return dir;
}

function listAffected(cwd: string, extraArgs: readonly string[] = []): ShardSpec[] {
  const result = runCmdSync(
    'node',
    [
      '--experimental-strip-types',
      path.join(repoRoot, 'scripts/mutation/run.ts'),
      '--list-affected',
      '--base',
      'HEAD~1',
      ...extraArgs,
    ],
    { cwd },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as ShardSpec[];
}

test('a lane-tooling diff selects real mutants', () => {
  const dir = worktreeWithCommit('tooling', ['scripts/mutation/run.ts']);
  // The lane's own sources own no kernel, so derivation alone yields nothing:
  // without the canary a harness change would run zero mutants.
  assert.deepEqual(listAffected(dir), shardMatrix([LANE_CANARY]));
});

// The weekly sweep is the kernel report; selecting on derived ownership would
// run the full ten-shard sweep on most PRs for a report nobody gates on.
test('a kernel diff selects nothing — only a harness diff spends mutants', () => {
  const dir = worktreeWithCommit('kernel', [
    'packages/capture-kit/src/snapshot/scroll-edge-state.ts',
  ]);
  assert.deepEqual(listAffected(dir), []);
  assert.deepEqual(
    affectedMatrixFor(['packages/capture-kit/src/snapshot/scroll-edge-state.ts']),
    [],
  );
});

test('non-harness paths, including near-miss manifests, select nothing', () => {
  for (const file of [
    'docs/agents/testing.md',
    'package.json.md',
    'packages/kernel/src/package.json',
    'packages/selectors/src/internal/parse.ts',
  ]) {
    assert.deepEqual(affectedMatrixFor([file]), [], file);
  }
});

test('lane code, config, and workflow changes select the harness canary', () => {
  for (const file of [
    'scripts/lib/cli-args.ts',
    'stryker.config.json',
    'vitest.mutation.config.ts',
    'vitest.config.ts',
    '.github/workflows/mutation-weekly.yml',
    '.github/workflows/mutation-affected.yml',
  ]) {
    assert.deepEqual(affectedMatrixFor([file]), shardMatrix([LANE_CANARY]), file);
  }
});

// Workspace manifests change in most cross-package PRs; spending the canary on
// each one is what the manual dispatch exists to avoid.
test('dependency and workspace manifest changes select the canary only with --with-dependencies', () => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'packages/kernel/package.json']) {
    assert.deepEqual(affectedMatrixFor([file]), [], file);
    assert.deepEqual(
      affectedMatrixFor([file], { withDependencies: true }),
      shardMatrix([LANE_CANARY]),
      file,
    );
  }
  const dir = worktreeWithCommit('manifest', ['packages/kernel/package.json']);
  assert.deepEqual(listAffected(dir), []);
  assert.deepEqual(listAffected(dir, ['--with-dependencies']), shardMatrix([LANE_CANARY]));
});
