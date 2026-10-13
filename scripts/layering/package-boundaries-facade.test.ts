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
  assert.deepEqual(
    checkRootSites(
      sites('src/cli.ts', '@agent-device/daemon/testing/session-store'),
      [daemon],
      PROD,
      true,
    ),
    [],
  );
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
