// R83 package-export-surface: the manifest scan (every shape of test support is caught, by key or
// by any condition target, wildcards included), the merge-base ratchet, and the consumer-side ban
// at the R11 import sites.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPackageInternalSites,
  checkRootSites,
  specifierSites,
  workspacePackagesFromManifests,
} from './package-boundaries.ts';
import {
  checkPackageExportSurface,
  expandExportTarget,
  isTestOnlyExport,
  isTestOnlyExportSpecifier,
  measureTestOnlyExports,
  PACKAGE_EXPORT_SURFACE_RULE,
  packageExportSurfaceSummary,
} from './package-export-surface.ts';

function manifest(name: string, exports: unknown): Map<string, string> {
  const dir = name.replace('@agent-device/', '');
  return new Map([[`packages/${dir}/package.json`, JSON.stringify({ name, exports })]]);
}

function entry(target: string) {
  return { types: target, default: target };
}

function measure(name: string, exports: unknown, packageFiles: readonly string[] = []) {
  return measureTestOnlyExports(manifest(name, exports), packageFiles);
}

// Every shape the rule must catch: [description, export key, export target].
const TEST_SUPPORT_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  ['a *.fixtures.ts target under an innocent key', './thing', './src/thing.fixtures.ts'],
  ['a *.fixture.ts target under an innocent key', './thing', './src/thing.fixture.ts'],
  ['a *-fixture-* target', './thing', './src/thing-fixture-builders.ts'],
  ['a *-fixtures key', './thing-fixtures', './src/thing.ts'],
  ['a fixtures.ts target', './thing', './src/recording/fixtures.ts'],
  ['a target under __tests__/', './thing', './src/__tests__/support/thing.ts'],
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
  ['a *.spec.ts target', './thing', './src/thing.spec.ts'],
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
    const offenders = measure('@agent-device/planted', { [key]: entry(target) });
    assert.equal(offenders.length, 1, description);
    assert.equal(offenders[0]!.id, `@agent-device/planted ${key}`, description);
  }
});

test('production exports that merely mention test or support are not flagged', () => {
  for (const [key, target] of PRODUCTION_SHAPES) {
    assert.deepEqual(measure('@agent-device/planted', { [key]: entry(target) }), [], key);
  }
});

test('every export condition is judged, not only the selected one', () => {
  assert.equal(
    measure('@agent-device/planted', {
      './thing': { types: './src/thing.fixtures.ts', default: './src/thing.ts' },
    }).length,
    1,
    'a fixture in types only',
  );
  assert.equal(
    measure('@agent-device/planted', {
      './thing': { types: './src/thing.ts', default: './src/thing.fixtures.ts' },
    }).length,
    1,
    'a fixture in default only',
  );
  assert.equal(
    measure('@agent-device/planted', {
      './thing': { node: { import: './src/thing.fixtures.ts' }, default: './src/thing.ts' },
    }).length,
    1,
    'a fixture in a nested condition',
  );
  assert.deepEqual(
    measure('@agent-device/planted', {
      './thing': { types: './src/thing.ts', default: './src/thing.ts' },
    }),
    [],
  );
});

test('a string exports map and a missing one are both read', () => {
  const fixture = measure('@agent-device/p', './src/index.fixtures.ts');
  assert.equal(fixture.length, 1);
  assert.equal(fixture[0]!.id, '@agent-device/p .');
  assert.deepEqual(measure('@agent-device/p', './src/index.ts'), []);
  assert.deepEqual(measure('@agent-device/p', undefined), []);
});

test('a wildcard export is judged by the tracked files it publishes', () => {
  const files = [
    'packages/planted/src/index.ts',
    'packages/planted/src/things/a.ts',
    'packages/planted/src/things/b.fixtures.ts',
  ];
  const catchAll = measure('@agent-device/planted', { './*': entry('./src/*.ts') }, files);
  assert.equal(catchAll.length, 1);
  assert.ok(catchAll[0]!.targets.includes('./src/things/b.fixtures.ts'));
  assert.deepEqual(
    measure(
      '@agent-device/planted',
      { './*': entry('./src/*.ts') },
      files.filter((file) => !file.includes('fixtures')),
    ),
    [],
  );
  // A pattern with no match stands for its own text, so one aimed at __tests__/ is caught
  // before any file exists.
  assert.equal(
    measure('@agent-device/planted', { './things/*': entry('./src/__tests__/*.ts') }, []).length,
    1,
  );
});

test('expandExportTarget matches a star across directories and leaves literals alone', () => {
  const files = ['packages/p/src/a.ts', 'packages/p/src/dir/b.ts', 'packages/p/src/dir/b.js'];
  assert.deepEqual(expandExportTarget('packages/p', './src/*.ts', files), [
    './src/a.ts',
    './src/dir/b.ts',
  ]);
  assert.deepEqual(expandExportTarget('packages/p', './src/index.ts', files), ['./src/index.ts']);
});

test('test-kit is the one package allowed to export test support', () => {
  assert.deepEqual(
    measure('@agent-device/test-kit', { './device-fixtures': entry('./src/device-fixtures.ts') }),
    [],
  );
});

test('growth against the merge-base fails; a cleanup or an unchanged set passes', () => {
  const base = measure('@agent-device/planted', {
    './listed-fixtures': entry('./src/listed.fixtures.ts'),
    './gone-fixtures': entry('./src/gone.fixtures.ts'),
  });
  const head = measure('@agent-device/planted', {
    './listed-fixtures': entry('./src/listed.fixtures.ts'),
    './new-fixtures': entry('./src/new.fixtures.ts'),
  });
  const violations = checkPackageExportSurface(head, base);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, PACKAGE_EXPORT_SURFACE_RULE);
  assert.equal(violations[0]!.file, 'packages/planted/package.json');
  assert.match(violations[0]!.message, /exports '\.\/new-fixtures'.*new\.fixtures\.ts/);
  // Removing an export needs no edit, and an unchanged set is clean.
  assert.deepEqual(checkPackageExportSurface([], base), []);
  assert.deepEqual(checkPackageExportSurface(base, base), []);
});

test('a moved fixture file under an unchanged export key is not growth; a renamed key is', () => {
  const base = measure('@agent-device/planted', { './x-fixtures': entry('./src/x.fixtures.ts') });
  const moved = measure('@agent-device/planted', {
    './x-fixtures': entry('./src/deeper/x.fixtures.ts'),
  });
  const renamed = measure('@agent-device/planted', {
    './y-fixtures': entry('./src/x.fixtures.ts'),
  });
  assert.deepEqual(checkPackageExportSurface(moved, base), []);
  assert.equal(checkPackageExportSurface(renamed, base).length, 1);
});

test('a package new at head cannot bring test support with it', () => {
  const head = measure('@agent-device/brand-new', { './mocks': entry('./src/mocks.ts') });
  assert.equal(checkPackageExportSurface(head, []).length, 1);
});

test('the summary reports the remaining count against the merge-base', () => {
  const base = measure('@agent-device/planted', {
    './a-fixtures': entry('./src/a.ts'),
    './b-fixtures': entry('./src/b.ts'),
  });
  assert.match(
    packageExportSurfaceSummary(base.slice(0, 1), base),
    /1 test-only export\(s\) remain against 2 at the merge-base \(R83\)/,
  );
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
          './types-only': { types: './src/types-only.fixtures.ts', default: './src/types-only.ts' },
          './testing/*': entry('./src/__tests__/*.ts'),
          './wild/*': entry('./src/wild/*.ts'),
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
  '@agent-device/owner/types-only',
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

test('an export whose types condition is test support is refused whatever default says', () => {
  // The selected (default) target is production; only the `types` leaf is a fixture.
  assert.equal(refusals('src/commands/inventory.ts', '@agent-device/owner/types-only').length, 1);
  assert.deepEqual(refusals('src/commands/inventory.ts', '@agent-device/owner/wild/a'), []);
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

test('tests, specs, fixtures, test trees and scripts/ may import test-only exports and test-kit', () => {
  for (const specifier of [...TEST_ONLY_SPECIFIERS, '@agent-device/test-kit/tmp-dir']) {
    for (const file of [
      'src/__tests__/consumer.test.ts',
      'src/commands/thing.test.ts',
      'src/commands/thing.spec.ts',
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
