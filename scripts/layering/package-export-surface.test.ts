// R83 package-export-surface: the manifest scan (every shape of test support is caught, by key or
// by target), the shrink-only burn-down list, and the consumer-side ban at the R11 import sites.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPackageInternalSites,
  checkRootSites,
  readTrackedPackageManifests,
  specifierSites,
  workspacePackagesFromManifests,
} from './package-boundaries.ts';
import {
  checkPackageExportSurface,
  isProductionSource,
  isTestOnlyExport,
  isTestOnlyExportSpecifier,
  isTestSupportFile,
  PACKAGE_EXPORT_SURFACE_RULE,
} from './package-export-surface.ts';
import { TEST_ONLY_EXPORT_BURN_DOWN } from './package-export-surface-burn-down.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function manifest(name: string, exports: Record<string, unknown>): Map<string, string> {
  const dir = name.replace('@agent-device/', '');
  return new Map([[`packages/${dir}/package.json`, JSON.stringify({ name, exports })]]);
}

function entry(target: string) {
  return { types: target, default: target };
}

// Every shape the rule must catch: [description, export key, export target].
const TEST_SUPPORT_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  ['a *.fixtures.ts target under an innocent key', './thing', './src/thing.fixtures.ts'],
  ['a *.fixture.ts target under an innocent key', './thing', './src/thing.fixture.ts'],
  ['a *-fixture-* target', './thing', './src/thing-fixture-builders.ts'],
  ['a *-fixtures key', './thing-fixtures', './src/thing.ts'],
  ['a fixtures.ts target', './thing', './src/recording/fixtures.ts'],
  ['a target under __tests__/', './thing', './src/__tests__/support/thing.ts'],
  ['a pattern target under __tests__/', './things/*', './src/things/__tests__/*.ts'],
  ['a ./testing/ key', './testing/thing', './src/thing.ts'],
  ['a testing/ target directory', './thing', './src/testing/thing.ts'],
  ['a test-support key', './test-support', './src/thing.ts'],
  ['a test-support target', './thing', './src/test-support.ts'],
  ['a test-host key', './runner/test-host', './src/runner/thing.ts'],
  ['a test-host target', './thing', './src/runner/test-host.ts'],
  ['a fake key', './fake-thing', './src/thing.ts'],
  ['a fake target', './thing', './src/fakes/thing.ts'],
  ['a mock key', './thing-mocks', './src/thing.ts'],
  ['a mock target', './thing', './src/thing.mock.ts'],
  ['a stub target', './thing', './src/thing-stub.ts'],
  ['a harness key', './thing-harness', './src/thing.ts'],
  ['a harness target', './thing', './src/thing-harness.ts'],
  ['a *.test.ts target', './thing', './src/thing.test.ts'],
  ['a test/ target directory', './thing', './test/thing.ts'],
];

// Production exports whose names merely contain "test" or "support".
const PRODUCTION_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['./test-command', './src/daemon-port/test-command.ts'],
  ['./session-test-outcome', './src/daemon-port/session-test-outcome.ts'],
  ['./session-test-source-discovery', './src/daemon-port/session-test-source-discovery.ts'],
  ['./android-clipboard-support', './src/android-clipboard-support.ts'],
  ['./connection-verification', './src/testmu-connection-verification.ts'],
  ['./snapshot', './src/snapshot/index.ts'],
  ['.', './src/index.ts'],
];

test('every shape of test support is caught, by key or by target', () => {
  for (const [description, key, target] of TEST_SUPPORT_SHAPES) {
    const violations = checkPackageExportSurface(
      manifest('@agent-device/planted', { [key]: entry(target) }),
      [],
    );
    assert.equal(violations.length, 1, description);
    assert.equal(violations[0]!.rule, PACKAGE_EXPORT_SURFACE_RULE, description);
    assert.match(violations[0]!.message, /exports test support|exports '/, description);
  }
});

test('production exports that merely mention test or support are not flagged', () => {
  for (const [key, target] of PRODUCTION_SHAPES) {
    assert.deepEqual(
      checkPackageExportSurface(manifest('@agent-device/planted', { [key]: entry(target) }), []),
      [],
      key,
    );
  }
});

test('every export condition is judged, not only the default', () => {
  const violations = checkPackageExportSurface(
    manifest('@agent-device/planted', {
      './thing': { types: './src/thing.ts', default: './src/thing.fixtures.ts' },
    }),
    [],
  );
  assert.equal(violations.length, 1);
});

test('a string exports map and a missing one are both read', () => {
  const dir = (value: unknown) =>
    new Map([
      ['packages/p/package.json', JSON.stringify({ name: '@agent-device/p', exports: value })],
    ]);
  assert.deepEqual(checkPackageExportSurface(dir('./src/index.ts'), []), []);
  assert.deepEqual(checkPackageExportSurface(dir(undefined), []), []);
});

test('test-kit is the one package allowed to export test support', () => {
  assert.deepEqual(
    checkPackageExportSurface(
      manifest('@agent-device/test-kit', {
        './device-fixtures': entry('./src/device-fixtures.ts'),
      }),
      [],
    ),
    [],
  );
});

test('the burn-down list is shrink-only: a new offender fails and so does a stale entry', () => {
  const planted = manifest('@agent-device/planted', {
    './listed-fixtures': entry('./src/listed.fixtures.ts'),
    './new-fixtures': entry('./src/new.fixtures.ts'),
  });
  const violations = checkPackageExportSurface(planted, [
    '@agent-device/planted ./listed-fixtures',
    '@agent-device/planted ./gone-fixtures',
  ]);
  assert.equal(violations.length, 2);
  assert.match(violations[0]!.message, /exports '\.\/new-fixtures'/);
  assert.equal(violations[0]!.file, 'packages/planted/package.json');
  assert.match(violations[1]!.message, /'@agent-device\/planted \.\/gone-fixtures' no longer/);
  assert.equal(violations[1]!.file, 'scripts/layering/package-export-surface-burn-down.ts');
});

test('a burn-down entry whose package is gone is stale', () => {
  const violations = checkPackageExportSurface(
    manifest('@agent-device/other', { '.': entry('./src/index.ts') }),
    ['@agent-device/missing ./thing-fixtures'],
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /delete it from TEST_ONLY_EXPORT_BURN_DOWN/);
});

test('the committed manifests offend exactly where the burn-down list says', () => {
  assert.deepEqual(
    checkPackageExportSurface(readTrackedPackageManifests(repoRoot), TEST_ONLY_EXPORT_BURN_DOWN),
    [],
  );
});

test('the burn-down list is unique and names a package and an export key per entry', () => {
  assert.equal(new Set(TEST_ONLY_EXPORT_BURN_DOWN).size, TEST_ONLY_EXPORT_BURN_DOWN.length);
  for (const line of TEST_ONLY_EXPORT_BURN_DOWN) {
    assert.match(line, /^@agent-device\/[a-z-]+ \.(?:\/\S+)?$/, line);
    assert.ok(!line.startsWith('@agent-device/test-kit '), 'test-kit is exempt, never listed');
  }
});

test('the key predicate works on specifiers too, for rules that hold only the specifier', () => {
  assert.equal(isTestOnlyExportSpecifier('@agent-device/platform-apple/runner/test-host'), true);
  assert.equal(
    isTestOnlyExportSpecifier('@agent-device/selectors/snapshot-geometry-fixtures'),
    true,
  );
  assert.equal(isTestOnlyExportSpecifier('@agent-device/platform-apple/runner/operations'), false);
  assert.equal(isTestOnlyExportSpecifier('@agent-device/platform-apple'), false);
  assert.equal(isTestOnlyExportSpecifier('node:fs'), false);
  assert.equal(isTestOnlyExport('./thing', ['./src/thing.fixtures.ts']), true);
});

test('isTestSupportFile and isProductionSource split the tree', () => {
  for (const file of [
    'test/integration/consumer.ts',
    'packages/daemon-side/test/harness.ts',
    'src/daemon/__tests__/consumer.ts',
    '__tests__/root-consumer.ts',
    'scripts/layering/daemon-layers.test.tsx',
    'src/daemon/session-store.test.mts',
    'src/foo.test.js',
    'src/foo.test.cjs',
    'src/platform-runtime-gateway.fixtures.ts',
    'packages/platform-android/src/recording/fixtures.ts',
    'packages/test-kit/src/loopback.ts',
  ]) {
    assert.equal(isTestSupportFile(file), true, file);
    assert.equal(isProductionSource(file), false, file);
  }
  for (const file of [
    'src/commands/inventory.ts',
    'packages/kernel/src/errors.ts',
    'packages/daemon/src/sessions/session-store.ts',
  ]) {
    assert.equal(isTestSupportFile(file), false, file);
    assert.equal(isProductionSource(file), true, file);
  }
  // Tooling and vitest setup are not production sources, so they may import test support.
  for (const file of ['scripts/vitest-apple-runner-host-setup.ts', 'scripts/fuzz/arbitraries.ts']) {
    assert.equal(isProductionSource(file), false, file);
  }
});

const packages = workspacePackagesFromManifests(
  new Map([
    [
      'packages/owner/package.json',
      JSON.stringify({
        name: '@agent-device/owner',
        private: true,
        exports: {
          '.': entry('./src/index.ts'),
          './thing': entry('./src/thing.ts'),
          './thing-fixtures': entry('./src/thing.fixtures.ts'),
          './testing/*': entry('./src/__tests__/*.ts'),
        },
      }),
    ],
    [
      'packages/test-kit/package.json',
      JSON.stringify({
        name: '@agent-device/test-kit',
        private: true,
        exports: { './tmp-dir': entry('./src/tmp-dir.ts') },
      }),
    ],
    [
      'packages/consumer/package.json',
      JSON.stringify({
        name: '@agent-device/consumer',
        private: true,
        exports: { '.': entry('./src/index.ts') },
        dependencies: {
          '@agent-device/owner': 'workspace:*',
          '@agent-device/test-kit': 'workspace:*',
        },
      }),
    ],
  ]),
);
const consumer = packages.find((pkg) => pkg.name === '@agent-device/consumer')!;
const rootDeps = new Set(['@agent-device/owner', '@agent-device/test-kit']);

function refusals(file: string, specifier: string) {
  const sites = specifierSites(file, `import { x } from '${specifier}';`);
  const inPackage = file.startsWith('packages/consumer/');
  return (
    inPackage
      ? checkPackageInternalSites(consumer, sites, packages, true)
      : checkRootSites(sites, packages, rootDeps, true)
  ).filter((violation) => violation.rule === PACKAGE_EXPORT_SURFACE_RULE);
}

const TEST_ONLY_SPECIFIERS = [
  '@agent-device/owner/thing-fixtures',
  '@agent-device/owner/testing/anything',
];

test('production source importing a test-only export is refused, at root and in packages', () => {
  for (const specifier of TEST_ONLY_SPECIFIERS) {
    for (const file of ['src/commands/inventory.ts', 'packages/consumer/src/inventory.ts']) {
      const violations = refusals(file, specifier);
      assert.equal(violations.length, 1, `${file} ${specifier}`);
      assert.match(violations[0]!.message, /test-only export/);
    }
  }
});

test('the vi.mock scan refuses a planted test-only export in production source too', () => {
  const planted = "vi.mock('@agent-device/owner/thing-fixtures', () => ({}));";
  const violations = checkRootSites(
    specifierSites('src/platform-runtime-something.ts', planted),
    packages,
    rootDeps,
    true,
  );
  assert.equal(violations.filter((v) => v.rule === PACKAGE_EXPORT_SURFACE_RULE).length, 1);
});

test('tests, fixtures, the test/ tree and scripts/ may import test-only exports and test-kit', () => {
  for (const specifier of [...TEST_ONLY_SPECIFIERS, '@agent-device/test-kit/tmp-dir']) {
    for (const file of [
      'src/__tests__/consumer.test.ts',
      'src/commands/thing.test.ts',
      'src/commands/thing.fixtures.ts',
      'test/integration/consumer.ts',
      'scripts/vitest-setup.ts',
      'packages/consumer/src/__tests__/consumer.test.ts',
      'packages/consumer/src/thing.fixtures.ts',
      'packages/consumer/test/harness.ts',
    ]) {
      assert.deepEqual(refusals(file, specifier), [], `${file} ${specifier}`);
    }
  }
});

test('production source importing test-kit is refused', () => {
  for (const file of ['src/commands/inventory.ts', 'packages/consumer/src/inventory.ts']) {
    const violations = refusals(file, '@agent-device/test-kit/tmp-dir');
    assert.equal(violations.length, 1, file);
    assert.match(violations[0]!.message, /private test-only package/);
  }
});

test('a production subpath of the same package stays importable from production source', () => {
  for (const file of ['src/commands/inventory.ts', 'packages/consumer/src/inventory.ts']) {
    assert.deepEqual(refusals(file, '@agent-device/owner/thing'), [], file);
    assert.deepEqual(refusals(file, '@agent-device/owner'), [], file);
  }
});
