import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { resetAllProcessMemosForTests } from '../ttl-memo.ts';
import { findProjectRoot, readVersion } from '../version.ts';

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

// The package version and the project root are immutable for the life of a
// process: nothing can rewrite the running code's own package.json in a way
// the process is allowed to observe. Every CLI invocation reads both several
// times (daemon reuse check, transport client version, help header), so they
// are computed once per process and reset between tests.

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
