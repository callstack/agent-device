import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { resolveAgentDeviceProjectRoot } from './project-root.ts';
import { compareVersions, findProjectRoot, isNewerVersion, readVersion } from './version.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Counts package.json reads while calling through to the real read. */
function countPackageJsonReads(): () => number {
  const readSpy = vi.spyOn(fs, 'readFileSync');
  return () =>
    readSpy.mock.calls.filter(
      ([target]) => typeof target === 'string' && target.endsWith('package.json'),
    ).length;
}

test('readVersion parses each root package.json once per process', () => {
  const root = mkdtempForTestSync('agent-device-version-memo-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n', 'utf8');
    const packageJsonReads = countPackageJsonReads();

    assert.equal(readVersion(root), '1.2.3');
    assert.equal(readVersion(root), '1.2.3');

    assert.equal(packageJsonReads(), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readVersion keys the memo per root and re-reads after a process memo reset', () => {
  const first = mkdtempForTestSync('agent-device-version-memo-first-');
  const second = mkdtempForTestSync('agent-device-version-memo-second-');
  try {
    fs.writeFileSync(path.join(first, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    fs.writeFileSync(path.join(second, 'package.json'), '{"version":"2.0.0"}\n', 'utf8');

    assert.equal(readVersion(first), '1.0.0');
    assert.equal(readVersion(second), '2.0.0');

    fs.writeFileSync(path.join(first, 'package.json'), '{"version":"1.0.1"}\n', 'utf8');
    assert.equal(readVersion(first), '1.0.0');

    resetAllProcessMemosForTests();
    assert.equal(readVersion(first), '1.0.1');
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('readVersion does not memoize a package.json it could not read', () => {
  const root = mkdtempForTestSync('agent-device-version-memo-absent-');
  try {
    assert.equal(readVersion(root), '0.0.0');

    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"3.0.0"}\n', 'utf8');
    assert.equal(readVersion(root), '3.0.0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findProjectRoot walks the ancestor chain once per process', () => {
  resetAllProcessMemosForTests();
  const existsSpy = vi.spyOn(fs, 'existsSync');

  const root = findProjectRoot();
  const walkCalls = existsSpy.mock.calls.length;
  assert.ok(walkCalls > 0);

  assert.equal(findProjectRoot(), root);
  assert.equal(existsSpy.mock.calls.length, walkCalls);
});

test('the resolver walks past a workspace-package manifest to the agent-device root', () => {
  const root = mkdtempForTestSync('agent-device-project-root-');
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'agent-device', version: '9.9.9' }),
    );
    const moduleDir = path.join(root, 'packages', 'capture-kit', 'src');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'packages', 'capture-kit', 'package.json'),
      JSON.stringify({ name: '@agent-device/capture-kit', version: '0.0.0' }),
    );

    assert.equal(resolveAgentDeviceProjectRoot(moduleDir), root);
    assert.equal(readVersion(resolveAgentDeviceProjectRoot(moduleDir)), '9.9.9');
  } finally {
    resetAllProcessMemosForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the resolver falls back to the nearest manifest when none names agent-device', () => {
  const root = mkdtempForTestSync('agent-device-project-root-fallback-');
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'vendored-fork', version: '1.0.0' }),
    );
    const nested = path.join(root, 'lib', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(resolveAgentDeviceProjectRoot(nested), root);
  } finally {
    resetAllProcessMemosForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('from this source tree, the project root is the agent-device manifest, not this package', () => {
  const resolved = findProjectRoot();
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
  };
  assert.equal(manifest.name, 'agent-device');
  assert.equal(readVersion(), manifest.version);
});

test('isNewerVersion orders releases numerically per segment', () => {
  assert.equal(isNewerVersion('0.21.6', '0.20.8'), true);
  assert.equal(isNewerVersion('0.21.12', '0.21.6'), true);
  assert.equal(isNewerVersion('1.0.0', '0.21.12'), true);
  assert.equal(isNewerVersion('0.20.8', '0.21.6'), false);
  assert.equal(isNewerVersion('0.21.6', '0.21.6'), false);
});

test('isNewerVersion ranks a release above the prerelease of the same base', () => {
  // main carries `-dev` between releases (scripts/release-mark-dev.mjs): a released client meeting
  // a `-dev` daemon of the same base is the upgrade, and the reverse is the downgrade.
  assert.equal(isNewerVersion('0.21.13', '0.21.13-dev'), true);
  assert.equal(isNewerVersion('0.21.13-dev', '0.21.13'), false);
  assert.equal(isNewerVersion('0.21.13-dev', '0.21.12'), true);
  assert.equal(isNewerVersion('0.21.12', '0.21.13-dev'), false);
  assert.equal(isNewerVersion('0.21.13-dev', '0.21.13-dev'), false);
  assert.equal(isNewerVersion('0.21.13-rc.2', '0.21.13-rc.1'), true);
  assert.equal(isNewerVersion('0.21.13-rc.10', '0.21.13-rc.9'), true);
  assert.equal(isNewerVersion('0.21.13-beta', '0.21.13-alpha.1'), true);
  assert.equal(isNewerVersion('0.21.13+build.2', '0.21.13+build.1'), false);
});

test('compareVersions reads malformed or prefixed versions conservatively', () => {
  assert.equal(compareVersions('v0.21.13', '0.21.13'), 0);
  assert.equal(compareVersions('garbage', '0.0.1'), -1);
  assert.equal(compareVersions('garbage', '0.0.0'), 0);
  assert.equal(compareVersions('1.2.3.4', '1.2.3'), -1, 'four segments is not a version');
});
