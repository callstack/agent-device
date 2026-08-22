import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { checkLockfileInstallSync } from './lockfile-install-sync.ts';

function writeLockfile(root: string, content: string): void {
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), content);
}

function writeInstalledSnapshot(root: string, content: string): void {
  const dir = path.join(root, 'node_modules', '.pnpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lock.yaml'), content);
}

test('reports in sync when the installed snapshot byte-matches the checked-out lockfile', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-match-');
  writeLockfile(root, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');

  assert.deepEqual(checkLockfileInstallSync(root), { inSync: true });
});

test('reports stale when the installed snapshot content differs from the checked-out lockfile', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-stale-');
  writeLockfile(
    root,
    'lockfileVersion: 9.0\nimporters:\n  .:\n    dependencies:\n      newDep: 1.0.0\n',
  );
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');

  assert.deepEqual(checkLockfileInstallSync(root), { inSync: false, reason: 'stale' });
});

test('reports install-missing when node_modules/.pnpm/lock.yaml does not exist', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-no-install-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');

  assert.deepEqual(checkLockfileInstallSync(root), { inSync: false, reason: 'install-missing' });
});

test('reports install-missing for a fresh worktree that has no node_modules directory at all', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-fresh-worktree-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');
  // Deliberately no node_modules directory — the exact state of a brand new
  // `git worktree add`, before its first `pnpm install`.
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);

  assert.deepEqual(checkLockfileInstallSync(root), { inSync: false, reason: 'install-missing' });
});

test('reports lockfile-missing when the checkout has no pnpm-lock.yaml', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-no-lockfile-');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\n');

  assert.deepEqual(checkLockfileInstallSync(root), { inSync: false, reason: 'lockfile-missing' });
});

test('is not fooled by two worktrees sharing the same repo but different lockfile states', () => {
  // The failure mode from #1963: a worktree's own node_modules must be compared against
  // that same worktree's own pnpm-lock.yaml, never another checkout's.
  const worktreeA = mkdtempForTestSync('agent-device-lockfile-sync-worktree-a-');
  const worktreeB = mkdtempForTestSync('agent-device-lockfile-sync-worktree-b-');
  writeLockfile(worktreeA, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');
  writeInstalledSnapshot(worktreeA, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');
  writeLockfile(
    worktreeB,
    'lockfileVersion: 9.0\nimporters:\n  .:\n    dependencies:\n      newDep: 1.0.0\n',
  );
  writeInstalledSnapshot(worktreeB, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');

  assert.deepEqual(checkLockfileInstallSync(worktreeA), { inSync: true });
  assert.deepEqual(checkLockfileInstallSync(worktreeB), { inSync: false, reason: 'stale' });
});
