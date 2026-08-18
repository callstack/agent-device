import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '../../src/utils/exec.ts';
import { withWorktrees } from './worktrees.ts';

// A throwaway repository with one commit; every case below plants a failure somewhere in the
// add → run → cleanup sequence and asserts that nothing the helper created outlives it.

function makeRepo(): { repo: string; commit: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evidence-worktrees-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (args: string[]) => runCmdSync('git', args, { cwd: repo }).stdout.trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'wt@test']);
  git(['config', 'user.name', 'wt']);
  fs.writeFileSync(path.join(repo, 'file'), 'x\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'one']);
  return { repo, commit: git(['rev-parse', 'HEAD']) };
}

function registered(repo: string): string[] {
  return runCmdSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo })
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((dir) => dir !== fs.realpathSync(repo));
}

test('worktrees are created in order, handed over as a tuple, and removed with the scratch after success', async () => {
  const { repo, commit } = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evidence-scratch-'));
  const seen = await withWorktrees(
    repo,
    scratch,
    [
      { name: 'head', commit },
      { name: 'base', commit },
    ],
    async ([head, base]) => {
      assert.ok(fs.existsSync(path.join(head, 'file')));
      assert.ok(fs.existsSync(path.join(base, 'file')));
      assert.equal(registered(repo).length, 2);
      return [path.basename(head), path.basename(base)];
    },
  );
  assert.deepEqual(seen, ['head', 'base']);
  assert.deepEqual(registered(repo), []);
  assert.equal(fs.existsSync(scratch), false);
});

test('a second add that fails leaks nothing: the first worktree is already registered and gets removed', async () => {
  const { repo, commit } = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evidence-scratch-'));
  await assert.rejects(
    withWorktrees(
      repo,
      scratch,
      [
        { name: 'head', commit },
        { name: 'base', commit: 'not-a-commit' },
      ],
      async () => {
        throw new Error('fn must not run when an add failed');
      },
    ),
    /git exited with code 128/,
  );
  assert.deepEqual(registered(repo), [], 'the successful first add was cleaned up');
  assert.equal(fs.existsSync(scratch), false);
});

test('a throwing fn still gets every worktree and the scratch removed', async () => {
  const { repo, commit } = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evidence-scratch-'));
  await assert.rejects(
    withWorktrees(repo, scratch, [{ name: 'only', commit }], async () => {
      throw new Error('measurement failed');
    }),
    /measurement failed/,
  );
  assert.deepEqual(registered(repo), []);
  assert.equal(fs.existsSync(scratch), false);
});

test('one cleanup failure never skips the remaining resources, and every failure is reported', async () => {
  const { repo, commit } = makeRepo();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-evidence-scratch-'));
  const removed: string[] = [];
  await assert.rejects(
    withWorktrees(
      repo,
      scratch,
      [
        { name: 'first', commit },
        { name: 'second', commit },
        { name: 'third', commit },
      ],
      async () => 'ok',
      (root, worktree) => {
        if (worktree.endsWith('second')) throw new Error('planted removal failure');
        runCmdSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
        removed.push(path.basename(worktree));
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cleanup left resources behind/);
      assert.match(error.message, /second: planted removal failure/);
      return true;
    },
  );
  assert.deepEqual(removed, ['first', 'third'], 'the failure in the middle skipped nothing');
  assert.equal(fs.existsSync(scratch), false, 'the scratch was still attempted');
});
