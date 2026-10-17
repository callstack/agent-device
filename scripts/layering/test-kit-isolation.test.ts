// The shape of test-kit (R83): a single entry that names its exports, plus the shared isolation
// walk (package-isolation.test.ts) composed under its policy.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseManifests } from './package-isolation.ts';
import { checkTestKitIsolation } from './test-kit-isolation.ts';

type Manifest = Record<string, unknown>;

function entry(target: string) {
  return { types: target, default: target };
}

/** A workspace of manifests keyed by package directory name; test-kit builds on kernel. */
function workspace(overrides: Record<string, Manifest> = {}): Map<string, string> {
  const base: Record<string, Manifest> = {
    'test-kit': {
      name: '@agent-device/test-kit',
      exports: { '.': entry('./src/index.ts') },
      dependencies: { '@agent-device/kernel': 'workspace:*' },
    },
    kernel: { name: '@agent-device/kernel', exports: { '.': entry('./src/index.ts') } },
    'platform-android': { name: '@agent-device/platform-android' },
    'platform-apple': { name: '@agent-device/platform-apple' },
    'provider-testmu': { name: '@agent-device/testmu' },
    'provider-limrun': { name: '@agent-device/provider-limrun' },
    daemon: { name: '@agent-device/daemon' },
    proxy: { name: '@agent-device/proxy' },
    contracts: { name: '@agent-device/contracts' },
  };
  const merged: Record<string, Manifest> = { ...base };
  for (const [dir, manifest] of Object.entries(overrides)) {
    merged[dir] = { ...base[dir], ...manifest };
  }
  return new Map(
    Object.entries(merged).map(([dir, manifest]) => [
      `packages/${dir}/package.json`,
      JSON.stringify(manifest),
    ]),
  );
}

const SOURCE = new Map([
  ['packages/test-kit/src/index.ts', "export { a } from './a.ts';"],
  ['packages/test-kit/src/a.ts', "import { x } from '@agent-device/kernel/errors';"],
]);

function check(overrides: Record<string, Manifest> = {}, sources = SOURCE) {
  return checkTestKitIsolation(parseManifests(workspace(overrides)), sources);
}

test('the test-kit shape holds: one entry, built only on packages below it', () => {
  assert.deepEqual(check(), []);
});

test('test-kit exports exactly "." and nothing else', () => {
  const extra = check({
    'test-kit': { exports: { '.': entry('./src/index.ts'), './tmp-dir': entry('./src/x.ts') } },
  });
  assert.equal(extra.length, 1);
  assert.match(extra[0]!.message, /exports exactly "\."/);
  assert.equal(check({ 'test-kit': { exports: { './tmp-dir': entry('./x.ts') } } }).length, 1);
});

test('the entry names its exports: export * is refused', () => {
  for (const body of [
    "export * from './a.ts';",
    "export { a } from './a.ts';\nexport * as ns from './b.ts';",
  ]) {
    const found = check({}, new Map([['packages/test-kit/src/index.ts', body]]));
    assert.equal(found.length, 1, body);
    assert.match(found[0]!.message, /names every export explicitly/);
  }
  assert.deepEqual(
    check({}, new Map([['packages/test-kit/src/index.ts', "export { a } from './a.ts';"]])),
    [],
  );
});

test('every condition of the "." entry must point at src/index.ts', () => {
  for (const exports of [
    { '.': entry('./src/other.ts') },
    { '.': { types: './src/index.ts', default: './src/other.ts' } },
    { '.': { types: './src/other.ts', default: './src/index.ts' } },
    { '.': { node: { import: './src/other.ts' }, default: './src/index.ts' } },
    { '.': './src/other.ts' },
    { '.': {} },
  ]) {
    const found = check({ 'test-kit': { exports } });
    assert.equal(found.length, 1, JSON.stringify(exports));
    assert.match(found[0]!.message, /every condition of it is \.\/src\/index\.ts/);
  }
  assert.deepEqual(check({ 'test-kit': { exports: { '.': './src/index.ts' } } }), []);
});

test('the shared isolation walk runs under the test-kit policy', () => {
  const found = check({ 'test-kit': { dependencies: { '@agent-device/daemon': 'workspace:*' } } });
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /test-kit -> @agent-device\/daemon/);
});
