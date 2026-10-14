// The workspace packages' test-only fixture subpaths: which subpaths the manifests expose as
// test-only, and which consumers R11 may import them. `TEST_ONLY_FIXTURE_SUBPATHS` in
// package-boundaries.ts makes the non-production-consumer claim for the non-platform packages
// R13 cannot reach; the platform fixture entries and their R13 predicate are pinned in
// platform-package-policy.test.ts. Split out of package-boundaries.test.ts when the R11 family
// crossed the test-size tripwire, move-only (the facade-surface.test.ts precedent); the
// platform-android manifest pin moved with them, so this file holds the whole fixture-subpath
// inventory question in one place.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkPackageInternalSites,
  checkRootSites,
  readWorkspacePackages,
  specifierSites,
  TEST_ONLY_FIXTURE_SUBPATHS,
  type WorkspacePackage,
} from './package-boundaries.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const kernel: WorkspacePackage = {
  dir: 'packages/kernel',
  name: '@agent-device/kernel',
  exportTargets: new Map([
    ['@agent-device/kernel/errors', 'packages/kernel/src/errors.ts'],
    ['@agent-device/kernel/device', 'packages/kernel/src/device.ts'],
  ]),
  workspaceDependencies: new Set(),
  workspaceDependencyField: 'dependencies',
  externalDependencies: new Map(),
};

const contracts: WorkspacePackage = {
  dir: 'packages/contracts',
  name: '@agent-device/contracts',
  exportTargets: new Map([
    ['@agent-device/contracts/interaction', 'packages/contracts/src/interaction.ts'],
  ]),
  workspaceDependencies: new Set(['@agent-device/kernel']),
  workspaceDependencyField: 'dependencies',
  externalDependencies: new Map(),
};

const ALL = [kernel, contracts];

test('the test-only fixture subpaths accept test consumers and deny production ones', () => {
  // A consumer package declaring both fixture owners, so only the fixture predicate can fire.
  const consumer: WorkspacePackage = {
    dir: 'packages/daemon-side',
    name: '@agent-device/daemon-side',
    exportTargets: new Map(),
    workspaceDependencies: new Set(['@agent-device/device-selection', '@agent-device/replay-port']),
    workspaceDependencyField: 'dependencies',
    externalDependencies: new Map(),
  };
  const rootDeps = new Set(consumer.workspaceDependencies);
  // Pin the set independently: iterating the checker's own set would let deleting an entry
  // silently delete its accept/deny coverage with it.
  assert.deepEqual([...TEST_ONLY_FIXTURE_SUBPATHS].sort(), [
    '@agent-device/device-selection/inventory-gateways-fixtures',
    '@agent-device/replay-port/replay-script-source-fixtures',
  ]);
  for (const specifier of TEST_ONLY_FIXTURE_SUBPATHS) {
    const sites = (file: string) => specifierSites(file, `import { f } from '${specifier}';`);
    for (const file of [
      'src/daemon/__tests__/consumer.test.ts',
      'test/integration/consumer.ts',
      'packages/daemon-side/src/__tests__/consumer.test.ts',
      'packages/daemon-side/test/harness.ts',
    ]) {
      assert.deepEqual(checkRootSites(sites(file), ALL, rootDeps, true), [], file);
      assert.deepEqual(checkPackageInternalSites(consumer, sites(file), ALL, true), [], file);
    }
    // Production consumers ride no seam: the same import from a root or package
    // production file is an R11 violation in both scans.
    for (const file of ['src/commands/inventory.ts', 'packages/daemon-side/src/inventory.ts']) {
      const violations = file.startsWith('src/')
        ? checkRootSites(sites(file), ALL, rootDeps, true)
        : checkPackageInternalSites(consumer, sites(file), ALL, true);
      assert.equal(violations.length, 1, file);
      assert.match(violations[0]!.message, /test-only fixture subpath/);
    }
  }
});

test('the platform-android manifest names its test-only fixture subpaths', () => {
  // The shared Android capture/walk fixtures (#3517). R13 denies production consumers
  // (platform-package-policy.test.ts); their place in the manifest's export list is the
  // R11-side half of the same inventory, pinned here with the full key list rather than
  // growing the R11 real-tree test past the size tripwire.
  const platformAndroidPackage = readWorkspacePackages(repoRoot).find(
    (pkg) => pkg.name === '@agent-device/platform-android',
  );
  assert.ok(platformAndroidPackage, 'platform-android package must exist');
  assert.deepEqual([...platformAndroidPackage.exportTargets.keys()].sort(), [
    '@agent-device/platform-android',
    '@agent-device/platform-android/adb-host',
    '@agent-device/platform-android/device-boot',
    '@agent-device/platform-android/mechanics',
    // Test-only entries: the shared Android capture/walk fixtures (#3517).
    '@agent-device/platform-android/snapshot-capture-fixtures',
    '@agent-device/platform-android/ui-hierarchy-fixtures',
  ]);
});
