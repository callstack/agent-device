// The shape of test-kit (R83): one entry, built only on packages below its consumers, no platform,
// provider, daemon or root package reached directly or transitively, and no package it reaches
// declaring it back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  return checkTestKitIsolation(workspace(overrides), sources);
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

test('test-kit may not depend on a platform, provider, daemon or root package, in any field', () => {
  for (const name of [
    '@agent-device/platform-apple',
    '@agent-device/provider-limrun',
    '@agent-device/testmu',
    '@agent-device/daemon',
    'agent-device',
  ]) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const found = check({ 'test-kit': { [field]: { [name]: 'workspace:*' } } });
      assert.equal(found.length, 1, `${name} in ${field}`);
      assert.match(found[0]!.message, /belongs in it/);
    }
  }
});

test('a provider published under a non-provider name is forbidden by its directory', () => {
  const found = check({
    'test-kit': { dependencies: { '@agent-device/testmu': 'workspace:*' } },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /test-kit -> @agent-device\/testmu/);
  // A lookalike name outside those directories is an ordinary package.
  assert.deepEqual(
    check({ 'test-kit': { dependencies: { '@agent-device/proxy': 'workspace:*' } } }),
    [],
  );
});

test('a forbidden package reached through another package is refused with its path', () => {
  const found = check({
    kernel: { dependencies: { '@agent-device/contracts': 'workspace:*' } },
    contracts: { optionalDependencies: { '@agent-device/platform-apple': 'workspace:*' } },
  });
  assert.equal(found.length, 1);
  assert.match(
    found[0]!.message,
    /test-kit -> @agent-device\/kernel -> @agent-device\/contracts -> @agent-device\/platform-apple/,
  );
});

test('a package test-kit reaches directly or transitively cannot declare test-kit', () => {
  const direct = check({
    kernel: { devDependencies: { '@agent-device/test-kit': 'workspace:*' } },
  });
  assert.equal(direct.length, 1);
  assert.equal(direct[0]!.file, 'packages/kernel/package.json');
  assert.match(direct[0]!.message, /project-reference cycle/);

  const transitive = check({
    kernel: { dependencies: { '@agent-device/contracts': 'workspace:*' } },
    contracts: { optionalDependencies: { '@agent-device/test-kit': 'workspace:*' } },
  });
  assert.equal(transitive.length, 1);
  assert.equal(transitive[0]!.file, 'packages/contracts/package.json');
  assert.match(
    transitive[0]!.message,
    /test-kit -> @agent-device\/kernel -> @agent-device\/contracts -> @agent-device\/test-kit/,
  );
});

test('a package outside test-kit reach may declare test-kit', () => {
  assert.deepEqual(
    check({ proxy: { devDependencies: { '@agent-device/test-kit': 'workspace:*' } } }),
    [],
  );
});

test('test-kit may not import a platform, provider, daemon or root module, or reach out of its directory', () => {
  for (const specifier of [
    '@agent-device/platform-android',
    '@agent-device/platform-apple/runner',
    '@agent-device/provider-limrun/connection',
    '@agent-device/testmu/connection-verification',
    '@agent-device/daemon/testing/context',
    '@agent-device/daemon',
    'agent-device/commands',
    '../../../src/platform-runtime-gateway.ts',
    '../../kernel/src/errors.ts',
  ]) {
    const found = check(
      {},
      new Map([['packages/test-kit/src/a.ts', `import { x } from '${specifier}';`]]),
    );
    assert.equal(found.length, 1, specifier);
    assert.equal(found[0]!.file, 'packages/test-kit/src/a.ts');
  }
  // A sibling inside its own directory, and a lookalike package name, are fine.
  assert.deepEqual(
    check(
      {},
      new Map([
        [
          'packages/test-kit/src/a.ts',
          "import { b } from './b.ts';\nimport { c } from '@agent-device/daemon-contracts/device-claims';",
        ],
      ]),
    ),
    [],
  );
});

test('the shared import walk applies: a vi.mock literal reaches a forbidden package too', () => {
  const found = check(
    {},
    new Map([
      [
        'packages/test-kit/src/a.ts',
        "import { vi } from 'vitest';\nvi.mock('@agent-device/platform-apple/runner', () => ({}));",
      ],
    ]),
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.line, 2);
});

test('a repo without a test-kit package has nothing to isolate', () => {
  assert.deepEqual(checkTestKitIsolation(new Map(), new Map()), []);
});
