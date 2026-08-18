import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCmd, runCmdSync } from '../../src/utils/exec.ts';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUN = path.join(REPOSITORY_ROOT, 'scripts', 'pr-evidence', 'run.ts');

function scratchDirectories(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('agent-device-pr-evidence-'));
}

function evidenceWorktrees(): string[] {
  return runCmdSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPOSITORY_ROOT })
    .stdout.split('\n')
    .filter((line) => line.startsWith('worktree ') && line.includes('agent-device-pr-evidence-'));
}

// The real entrypoint, end to end, in this repository: `--base HEAD` makes the merge-base HEAD
// itself, so it needs no origin/main and no network (a depth-1 CI checkout is enough) while
// still creating both pristine worktrees, running the selector, the layering guard, and the
// depgraph twice, and rendering the block. It is the regression for the fresh-checkout failure
// (scratch used to be created under an untracked, possibly absent `.tmp/`) and for cleanup.
test('pr:evidence runs end to end from a pristine head worktree and cleans up after itself', async () => {
  const before = { scratch: scratchDirectories(), worktrees: evidenceWorktrees() };
  const result = await runCmd(
    process.execPath,
    ['--experimental-strip-types', RUN, '--base', 'HEAD', '--json'],
    { cwd: REPOSITORY_ROOT, timeoutMs: 300_000 },
  );
  const inputs = JSON.parse(result.stdout) as {
    git: { head: string; base: string; changedFiles: string[]; dirty: boolean };
    affected: { checks: unknown[] };
    layering: { ok: boolean };
    depgraph: { head: { files: number; edges: number }; base: { files: number; edges: number } };
    coverage: { kind: string };
    size: { kind: string };
  };
  const head = runCmdSync('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }).stdout.trim();
  assert.equal(inputs.git.head, head);
  assert.equal(inputs.git.base, head, '--base HEAD makes the merge-base the head itself');
  assert.deepEqual(inputs.git.changedFiles, []);
  assert.ok(inputs.depgraph.head.files > 500, 'the head worktree was analyzed, not an empty tree');
  assert.deepEqual(inputs.depgraph.base, inputs.depgraph.head, 'same commit, same numbers');
  assert.equal(typeof inputs.layering.ok, 'boolean');
  assert.equal(inputs.coverage.kind, 'skipped');
  assert.equal(inputs.size.kind, 'skipped');
  // Both worktrees and the os.tmpdir() scratch are gone, whatever else was there before.
  assert.deepEqual(scratchDirectories(), before.scratch);
  assert.deepEqual(evidenceWorktrees(), before.worktrees);
});
