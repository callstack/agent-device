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

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'in-sync' });
});

test('reports stale when the installed snapshot content differs from the checked-out lockfile', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-stale-');
  writeLockfile(
    root,
    'lockfileVersion: 9.0\nimporters:\n  .:\n    dependencies:\n      newDep: 1.0.0\n',
  );
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\nimporters:\n  .: {}\n');

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'out-of-sync', reason: 'stale' });
});

test('reports install-missing when a source checkout has no installed snapshot', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-no-install-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');

  assert.deepEqual(checkLockfileInstallSync(root), {
    status: 'out-of-sync',
    reason: 'install-missing',
  });
});

test('reports install-missing for a fresh worktree that has no node_modules directory at all', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-fresh-worktree-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');
  // Deliberately no node_modules directory — the exact state of a brand new
  // `git worktree add`, before its first `pnpm install`. This must stay a real
  // finding: it is the resolve-to-main-checkout trap #1963 names.
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);

  assert.deepEqual(checkLockfileInstallSync(root), {
    status: 'out-of-sync',
    reason: 'install-missing',
  });
});

test('reports no-source-checkout when there is no pnpm-lock.yaml — the packaged-install shape', () => {
  // A published agent-device: package.json `files` ships bin/ and dist/ but never the
  // lockfile, and an npm tarball never carries node_modules. Neither file is present,
  // and the answer must be "not applicable" rather than any kind of defect.
  const root = mkdtempForTestSync('agent-device-lockfile-sync-packaged-');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n');

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'no-source-checkout' });
});

test('reports no-source-checkout even when a node_modules snapshot exists without a lockfile', () => {
  // The lockfile is the discriminator, not the snapshot: a consuming project could have
  // its own node_modules around the packaged install without that making our root a
  // source checkout to diagnose.
  const root = mkdtempForTestSync('agent-device-lockfile-sync-no-lockfile-');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\n');

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'no-source-checkout' });
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

  assert.deepEqual(checkLockfileInstallSync(worktreeA), { status: 'in-sync' });
  assert.deepEqual(checkLockfileInstallSync(worktreeB), { status: 'out-of-sync', reason: 'stale' });
});
