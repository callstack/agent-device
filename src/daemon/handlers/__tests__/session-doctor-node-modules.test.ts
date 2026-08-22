import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { STALE_NODE_MODULES_MESSAGE } from '../../../utils/lockfile-install-sync.ts';
import { nodeModulesLockfileCheck } from '../session-doctor-node-modules.ts';

function writeLockfile(root: string, content: string): void {
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), content);
}

function writeInstalledSnapshot(root: string, content: string): void {
  const dir = path.join(root, 'node_modules', '.pnpm');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lock.yaml'), content);
}

test('node-modules doctor check passes when the installed snapshot matches the checked-out lockfile', () => {
  const root = mkdtempForTestSync('agent-device-doctor-node-modules-sync-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\n');

  const check = nodeModulesLockfileCheck(root);
  assert.equal(check?.id, 'node-modules');
  assert.equal(check?.status, 'pass');
  assert.match(check?.summary ?? '', /matches pnpm-lock\.yaml/);
});

test('node-modules doctor check fails with the stale-install message when hashes disagree', () => {
  const root = mkdtempForTestSync('agent-device-doctor-node-modules-stale-');
  writeLockfile(root, 'lockfileVersion: 9.0\nfoo: bar\n');
  writeInstalledSnapshot(root, 'lockfileVersion: 9.0\n');

  const check = nodeModulesLockfileCheck(root);
  assert.equal(check?.status, 'fail');
  assert.equal(check?.summary, STALE_NODE_MODULES_MESSAGE);
  assert.equal(check?.command, 'pnpm install');
  assert.deepEqual(check?.evidence, { repoRoot: root, reason: 'stale' });
});

test('node-modules doctor check fails when a source checkout was never installed', () => {
  const root = mkdtempForTestSync('agent-device-doctor-node-modules-missing-install-');
  writeLockfile(root, 'lockfileVersion: 9.0\n');

  const check = nodeModulesLockfileCheck(root);
  assert.equal(check?.status, 'fail');
  assert.equal(check?.summary, STALE_NODE_MODULES_MESSAGE);
  assert.deepEqual(check?.evidence, { repoRoot: root, reason: 'install-missing' });
});

test('node-modules doctor check is omitted entirely for a packaged install with no source checkout', () => {
  // The defect this guards: a published agent-device ships neither pnpm-lock.yaml nor an
  // installed snapshot, so an unconditional probe gave every end user a spurious
  // node-modules line and dragged the overall doctor status down with it.
  const root = mkdtempForTestSync('agent-device-doctor-node-modules-packaged-');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"agent-device"}\n');

  assert.equal(nodeModulesLockfileCheck(root), undefined);
});

test("node-modules doctor check defaults to this checkout's own root, matching real doctor wiring", () => {
  // session-doctor.ts calls nodeModulesLockfileCheck() with no argument; this repo's own
  // install is expected to be in sync while the suite runs (pnpm install was run for it).
  const check = nodeModulesLockfileCheck();
  assert.equal(check?.id, 'node-modules');
  assert.equal(check?.status, 'pass');
});
