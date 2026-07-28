// Selection is what the PR lane spends money on, so both halves of the rule are
// asserted end to end through the real CLI: nothing runs before graduation, and
// the "prove the gate" exception for a lane-tooling diff selects real mutants
// rather than an empty matrix that proves nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runCmdSync } from '../../src/utils/exec.ts';
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

function listAffected(cwd: string): ShardSpec[] {
  const result = runCmdSync(
    'node',
    [
      '--experimental-strip-types',
      path.join(repoRoot, 'scripts/mutation/run.ts'),
      '--list-affected',
      '--base',
      'HEAD~1',
    ],
    { cwd },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as ShardSpec[];
}

test('a lane-tooling diff selects real mutants even before graduation', () => {
  const dir = worktreeWithCommit('tooling', ['scripts/mutation/ratchet.ts']);
  // The lane's own sources own no kernel, so derivation alone yields nothing:
  // without the canary this exception would run zero mutants.
  assert.deepEqual(listAffected(dir), shardMatrix([LANE_CANARY]));
});

test('a kernel diff selects nothing until the baseline graduates', () => {
  const dir = worktreeWithCommit('kernel', ['src/utils/scroll-edge-state.ts']);
  assert.deepEqual(listAffected(dir), []);
  // …and the same diff selects that module once gating is on.
  assert.deepEqual(
    affectedMatrixFor(['src/utils/scroll-edge-state.ts'], true),
    shardMatrix(['scroll-edge-state']),
  );
});

test('a docs-only diff selects nothing even once gating is on', () => {
  assert.deepEqual(affectedMatrixFor(['docs/agents/testing.md'], true), []);
});
