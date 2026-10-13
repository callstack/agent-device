// R11's ./testing/* façade rule bites: test data stays behind a pattern entry that only
// test files may import (owner review #3546). Compact sibling of package-boundaries.test.ts,
// which sits at its size ratchet.

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
    './testing/*': { types: './src/*.ts', default: './src/*.ts' },
  },
});
const [daemon] = workspacePackagesFromManifests(
  new Map([['packages/daemon/package.json', daemonManifest]]),
);

function sites(file: string, specifier: string) {
  return [{ file, line: 1, specifier }];
}
const PROD = new Set(['@agent-device/daemon']);

test('a production root file importing ./testing/* is refused', () => {
  const violations = checkRootSites(
    sites('src/commands/something.ts', '@agent-device/daemon/testing/__tests__/store-factory'),
    [daemon],
    PROD,
    true,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /publishes test data to test files only/);
});

test('a test root file importing ./testing/* passes, and a named entry stays open to all', () => {
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
    checkRootSites(sites('src/cli.ts', '@agent-device/daemon/session-store'), [daemon], PROD, true),
    [],
  );
});

test('the ./testing/* refusal bites inside packages and through the vi.mock scan', () => {
  const planted = "vi.mock('@agent-device/daemon/testing/__tests__/store-factory', () => ({}));";
  assert.deepEqual(
    checkPackageInternalSites(
      daemon,
      sites('packages/daemon/src/handlers/production.ts', '@agent-device/daemon/testing/x'),
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

test('a pattern entry matches deep specifiers for the named-surface check in scripts/', () => {
  // uncompiled sites must still resolve through the pattern rather than report "not named"
  assert.deepEqual(
    checkRootSites(
      sites('src/__tests__/x/y.test.ts', '@agent-device/daemon/testing/support/whatever'),
      [daemon],
      PROD,
      false,
    ),
    [],
  );
});
