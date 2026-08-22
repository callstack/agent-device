import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
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
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);

  assert.deepEqual(checkLockfileInstallSync(root), {
    status: 'out-of-sync',
    reason: 'install-missing',
  });
});

test('reports no-source-checkout when there is no pnpm-lock.yaml', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-packaged-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n');

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'no-source-checkout' });
});

test('reports no-source-checkout even when an installed snapshot exists without a lockfile', () => {
  const root = mkdtempForTestSync('agent-device-lockfile-sync-no-lockfile-');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\n');

  assert.deepEqual(checkLockfileInstallSync(root), { status: 'no-source-checkout' });
});

test('checks each worktree against its own lockfile state', () => {
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
