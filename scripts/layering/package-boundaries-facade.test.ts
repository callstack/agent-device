// R11's ./testing/ façade rule bites: test data stays behind the package's
// `./testing/` namespace — named `./testing/<fixture>` entries and per-folder
// `./testing/<dir>/*` patterns — that only test files may import (owner review
// #3546). Compact sibling of package-boundaries.test.ts, which sits at its size
// ratchet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkPackageInternalSites,
  checkRootSites,
  isTestConsumerFile,
  specifierSites,
  workspacePackagesFromManifests,
} from './package-boundaries.ts';

const daemonManifest = JSON.stringify({
  name: '@agent-device/daemon',
  private: true,
  exports: {
    './session-store': { types: './src/session-store.ts', default: './src/session-store.ts' },
    './testing/__tests__/store-factory': {
      types: './src/__tests__/store-factory.ts',
      default: './src/__tests__/store-factory.ts',
    },
    './testing/handlers/__tests__/*': {
      types: './src/handlers/__tests__/*.ts',
      default: './src/handlers/__tests__/*.ts',
    },
  },
});
const [daemon] = workspacePackagesFromManifests(
  new Map([['packages/daemon/package.json', daemonManifest]]),
);

function sites(file: string, specifier: string) {
  return [{ file, line: 1, specifier }];
}
const PROD = new Set(['@agent-device/daemon']);

test('a production root file importing the ./testing/ namespace is refused', () => {
  const violations = checkRootSites(
    sites('src/commands/something.ts', '@agent-device/daemon/testing/__tests__/store-factory'),
    [daemon],
    PROD,
    true,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /publishes test data to test files only/);
});

test('a test root file importing ./testing/ passes, and a named entry stays open to all', () => {
  assert.deepEqual(
    checkRootSites(
      sites(
        'src/__tests__/daemon-composition/anything.test.ts',
        '@agent-device/daemon/testing/__tests__/store-factory',
      ),
      [daemon],
      PROD,
      true,
    ),
    [],
  );
  // The exact spelling the fixture manifest names. A compiled site skips
  // resolution, so `[]` there would pass even for a specifier no entry exports;
  // the uncompiled pass reports "not named" for exactly that, so asserting []
  // in both modes is what proves this specifier resolves through the named entry.
  for (const compiled of [true, false]) {
    assert.deepEqual(
      checkRootSites(
        sites('src/cli.ts', '@agent-device/daemon/session-store'),
        [daemon],
        PROD,
        compiled,
      ),
      [],
    );
  }
});

test('the ./testing/ refusal bites inside packages and through the vi.mock scan', () => {
  const planted = "vi.mock('@agent-device/daemon/testing/__tests__/store-factory', () => ({}));";
  assert.deepEqual(
    checkPackageInternalSites(
      daemon,
      sites(
        'packages/daemon/src/handlers/production.ts',
        '@agent-device/daemon/testing/__tests__/store-factory',
      ),
      [daemon],
      true,
    ).length,
    1,
  );
  assert.equal(
    checkRootSites(
      specifierSites('src/platform-runtime-something.ts', planted),
      [daemon],
      PROD,
      true,
    ).length,
    1,
  );
});

test('a package-local test/ tree is a test consumer, its src/ tree is not', () => {
  // The file vocabulary TEST_ONLY_FIXTURE_SUBPATHS' predicate uses: a package's
  // own harness tree (`packages/<pkg>/test/`) imports fixtures just like the
  // root `test/` tree does; the same file under src/ does not (#3546 review).
  const consumer = workspacePackagesFromManifests(
    new Map([
      [
        'packages/daemon-side/package.json',
        JSON.stringify({
          name: '@agent-device/daemon-side',
          private: true,
          exports: { '.': './src/index.ts' },
          dependencies: { '@agent-device/daemon': 'workspace:*' },
        }),
      ],
    ]),
  )[0]!;
  const fixture = '@agent-device/daemon/testing/__tests__/store-factory';
  assert.deepEqual(
    checkPackageInternalSites(
      consumer,
      sites('packages/daemon-side/test/harness.ts', fixture),
      [daemon, consumer],
      true,
    ),
    [],
  );
  const denied = checkPackageInternalSites(
    consumer,
    sites('packages/daemon-side/src/harness.ts', fixture),
    [daemon, consumer],
    true,
  );
  assert.equal(denied.length, 1);
  assert.match(denied[0]!.message, /publishes test data to test files only/);
});

test('isTestConsumerFile accepts the test vocabulary and denies production files', () => {
  // One spelling serves both test-data gates (the ./testing/ façade check and the
  // TEST_ONLY_FIXTURE_SUBPATHS predicate), so the vocabulary itself is pinned here:
  // every accepted shape forwards to both gates, and the shapes that once spelled
  // differently across the two copies (.test.tsx, .mts, a root __tests__/ tree) are
  // in the accepted set (#3546 review).
  for (const file of [
    'test/integration/consumer.ts',
    'packages/daemon-side/test/harness.ts',
    'src/daemon/__tests__/consumer.ts',
    '__tests__/root-consumer.ts',
    'scripts/layering/daemon-layers.test.tsx',
    'src/daemon/session-store.test.mts',
    'src/foo.test.js',
    'src/foo.test.cjs',
  ]) {
    assert.equal(isTestConsumerFile(file), true, file);
  }
  for (const file of [
    'src/commands/inventory.ts',
    'packages/kernel/src/errors.ts',
    'scripts/layering/package-boundaries.ts',
    'testbed/notes.ts',
    'docs/writing/tests.ts',
    'src/foo.ts',
  ]) {
    assert.equal(isTestConsumerFile(file), false, file);
  }
});

test('a pattern entry matches deep specifiers, and an unnamed one is refused in scripts/', () => {
  // uncompiled sites resolve through the pattern rather than report "not named",
  // and a spelling no entry names still reports.
  assert.deepEqual(
    checkRootSites(
      sites(
        'src/__tests__/x/y.test.ts',
        '@agent-device/daemon/testing/handlers/__tests__/session-test-harness',
      ),
      [daemon],
      PROD,
      false,
    ),
    [],
  );
  const unnamed = checkRootSites(
    sites('src/__tests__/x/y.test.ts', '@agent-device/daemon/testing/support/whatever'),
    [daemon],
    PROD,
    false,
  );
  assert.equal(unnamed.length, 1);
  assert.match(unnamed[0]!.message, /not named by/);
});
