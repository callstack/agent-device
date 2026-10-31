// The shape of the pinned package entries (R83): test-kit, daemon, daemon-client, command-output and apple-runner publish a
// single entry that names its exports, and test-kit also runs the shared isolation walk
// (package-isolation.test.ts) under its policy.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseManifests } from './package-isolation.ts';
import { checkPackageEntrySurfaces } from './package-entry-surface.ts';

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
    'command-runtime': {
      name: '@agent-device/command-runtime',
      exports: { '.': entry('./src/index.ts') },
    },
    daemon: {
      name: '@agent-device/daemon',
      exports: { '.': entry('./src/index.ts') },
    },
    'apple-runner': {
      name: '@agent-device/apple-runner',
      exports: { '.': entry('./src/index.ts') },
    },
    'command-surface': {
      name: '@agent-device/command-surface',
      exports: { '.': entry('./src/index.ts') },
    },
    'daemon-client': {
      name: '@agent-device/daemon-client',
      exports: { '.': entry('./src/index.ts') },
    },
    'command-output': {
      name: '@agent-device/command-output',
      exports: { '.': entry('./src/index.ts') },
    },
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
  [
    'packages/command-runtime/src/index.ts',
    "export { createCommandSurfaceAgentDevice } from './surface.ts';",
  ],
  ['packages/test-kit/src/index.ts', "export { a } from './a.ts';"],
  ['packages/test-kit/src/a.ts', "import { x } from '@agent-device/kernel/errors';"],
  [
    'packages/daemon/src/index.ts',
    "export { startDaemonRuntime } from './server/http/daemon-runtime.ts';",
  ],
  ['packages/apple-runner/src/index.ts', "export { bindAppleRunnerHost } from './host.ts';"],
  ['packages/command-surface/src/index.ts', "export { runCommand } from './command-surface.ts';"],
  ['packages/daemon-client/src/index.ts', "export { sendToDaemon } from './transport.ts';"],
  ['packages/command-output/src/index.ts', "export { colorize } from './output/color.ts';"],
]);

function check(overrides: Record<string, Manifest> = {}, sources = SOURCE) {
  return checkPackageEntrySurfaces(parseManifests(workspace(overrides)), sources);
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

for (const dir of ['daemon', 'daemon-client', 'command-output']) {
  test(`${dir} exports exactly "." and nothing else`, () => {
    const extra = check({
      [dir]: {
        exports: {
          '.': entry('./src/index.ts'),
          './testing/context': entry('./src/core/context.ts'),
        },
      },
    });
    assert.equal(extra.length, 1);
    assert.match(extra[0]!.file, new RegExp(`packages/${dir}/package\\.json`));
    assert.match(extra[0]!.message, /exports exactly "\."/);
    assert.deepEqual(check(), []);
  });

  test(`every ${dir} condition of "." points at src/index.ts`, () => {
    for (const exports of [
      { '.': entry('./src/other.ts') },
      { '.': { types: './src/index.ts', default: './src/other.ts' } },
      { '.': './src/other.ts' },
    ]) {
      const found = check({ [dir]: { exports } });
      assert.equal(found.length, 1, JSON.stringify(exports));
      assert.match(found[0]!.file, new RegExp(`packages/${dir}/package\\.json`));
      assert.match(found[0]!.message, /every condition of it is \.\/src\/index\.ts/);
    }
    assert.deepEqual(check({ [dir]: { exports: { '.': './src/index.ts' } } }), []);
  });
}

test('apple-runner exports exactly "." and nothing else', () => {
  for (const exports of [
    { '.': entry('./src/index.ts'), './test-host': entry('./src/test-host.ts') },
    { '.': entry('./src/index.ts'), './runner/*': entry('./src/*.ts') },
    { './runner-client': entry('./src/index.ts') },
  ]) {
    const found = check({ 'apple-runner': { exports } });
    assert.equal(found.length, 1, JSON.stringify(exports));
    assert.match(found[0]!.file, /packages\/apple-runner\/package\.json/);
    assert.match(found[0]!.message, /exports exactly "\."/);
  }
});

test('every apple-runner condition of "." points at src/index.ts', () => {
  const found = check({
    'apple-runner': { exports: { '.': { types: './src/index.ts', default: './src/host.ts' } } },
  });
  assert.equal(found.length, 1);
  assert.match(found[0]!.message, /every condition of it is \.\/src\/index\.ts/);
});

test('the apple-runner entry names its exports: export * is refused', () => {
  for (const body of [
    "export * from './host.ts';",
    "export { bindAppleRunnerHost } from './host.ts';\nexport * as runner from './runner-session.ts';",
    "export type * from './host.ts';",
  ]) {
    const found = check({}, new Map([...SOURCE, ['packages/apple-runner/src/index.ts', body]]));
    assert.equal(found.length, 1, body);
    assert.match(found[0]!.file, /packages\/apple-runner\/src\/index\.ts/);
    assert.match(found[0]!.message, /names every export explicitly/);
  }
});

test('command-surface exports exactly "." and nothing else', () => {
  for (const exports of [
    { '.': entry('./src/index.ts'), './family/registry': entry('./src/family/registry.ts') },
    { '.': entry('./src/index.ts'), './schema/*': entry('./src/schema/*.ts') },
    { './command-input': entry('./src/command-input.ts') },
  ]) {
    const found = check({ 'command-surface': { exports } });
    assert.equal(found.length, 1, JSON.stringify(exports));
    assert.match(found[0]!.file, /packages\/command-surface\/package\.json/);
    assert.match(found[0]!.message, /exports exactly "\."/);
  }
  const retargeted = check({ 'command-surface': { exports: { '.': entry('./src/other.ts') } } });
  assert.equal(retargeted.length, 1);
  assert.match(retargeted[0]!.message, /every condition of it is \.\/src\/index\.ts/);
  assert.deepEqual(check(), []);
});

test('the command-surface entry names its exports: export * and namespace dumps are refused', () => {
  for (const body of [
    "export * from './command-surface.ts';",
    "export { runCommand } from './command-surface.ts';\nexport * as families from './family/registry.ts';",
    "export type * from './client-port.ts';",
  ]) {
    const found = check({}, new Map([...SOURCE, ['packages/command-surface/src/index.ts', body]]));
    assert.equal(found.length, 1, body);
    assert.equal(found[0]!.file, 'packages/command-surface/src/index.ts');
    assert.match(found[0]!.message, /names every export explicitly/);
  }
});

test('the entry names its exports: export * is refused', () => {
  for (const body of [
    "export * from './a.ts';",
    "export { a } from './a.ts';\nexport * as ns from './b.ts';",
    "export type * from './a.ts';",
    "export { a } from './a.ts';\nexport type * as ns from './b.ts';",
  ]) {
    const found = check({}, new Map([...SOURCE, ['packages/test-kit/src/index.ts', body]]));
    assert.equal(found.length, 1, body);
    assert.match(found[0]!.message, /names every export explicitly/);
  }
  assert.deepEqual(
    check(
      {},
      new Map([...SOURCE, ['packages/test-kit/src/index.ts', "export { a } from './a.ts';"]]),
    ),
    [],
  );
});

test('text that only mentions a star is not an export', () => {
  const body =
    "// export * from './a.ts' is forbidden here\n" +
    "const note = `export * from './b.ts'`;\nexport { note };\nexport { a } from './a.ts';";
  assert.deepEqual(check({}, new Map([...SOURCE, ['packages/test-kit/src/index.ts', body]])), []);
});

for (const dir of ['daemon', 'daemon-client', 'command-output']) {
  test(`the ${dir} entry names its exports: export * is refused`, () => {
    const sources = new Map(SOURCE);
    sources.set(`packages/${dir}/src/index.ts`, "export * from './transport.ts';");
    const found = check({}, sources);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.file, `packages/${dir}/src/index.ts`);
    assert.match(found[0]!.message, /names every export explicitly/);
    assert.deepEqual(check(), []);
  });
}

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

for (const dir of [
  'daemon',
  'daemon-client',
  'command-output',
  'apple-runner',
  'test-kit',
  'command-surface',
]) {
  test(`${dir} refuses a missing or renamed entry source`, () => {
    for (const renamed of [false, true]) {
      const sources = new Map(SOURCE);
      const file = `packages/${dir}/src/index.ts`;
      sources.delete(file);
      if (renamed) sources.set(`packages/${dir}/src/renamed.ts`, "export * from './a.ts';");
      const found = check({}, sources);
      assert.equal(found.length, 1);
      assert.equal(found[0]!.file, file);
      assert.match(found[0]!.message, /entry source is missing/);
    }
  });
}

test('command-runtime rejects subpaths and star exports', () => {
  const extra = check({
    'command-runtime': {
      exports: { '.': entry('./src/index.ts'), './internal': entry('./src/internal.ts') },
    },
  });
  assert.equal(extra.length, 1);
  assert.match(extra[0]!.file, /packages\/command-runtime\/package\.json/);
  const sources = new Map(SOURCE);
  sources.set('packages/command-runtime/src/index.ts', "export * from './surface.ts';");
  assert.equal(check({}, sources)[0]!.file, 'packages/command-runtime/src/index.ts');
});
