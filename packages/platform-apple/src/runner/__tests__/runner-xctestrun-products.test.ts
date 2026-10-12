import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { writeXctestrunFixture } from './runner-xctestrun.fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { resolveExistingXctestrunProductPaths } from '../runner-xctestrun-products.ts';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: originalPlatform,
  });
});

function pretendPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
}

/**
 * The test-host seam for plist decoding: `resolveExistingXctestrunProductPaths` reads the
 * xctestrun through the runner host's `readApplePlistJson`, so a JSON-shaped xctestrun is fed
 * in as the object `plutil` would have produced while the file itself still exists on disk for
 * the product-existence checks.
 */
function serveParsedPlist(parsed: Record<string, unknown> | null): void {
  appleRunnerTestHost.update({
    readApplePlistJson: async () => parsed,
  });
}

function seedProductBundle(root: string, relativeBundlePath: string): string {
  const bundlePath = path.join(root, relativeBundlePath);
  fs.mkdirSync(bundlePath, { recursive: true });
  fs.writeFileSync(path.join(bundlePath, path.basename(relativeBundlePath, '.app')), 'runner');
  return bundlePath;
}

test('a modern xctestrun resolves its configured targets through every product-reference key', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const xctestrunPath = path.join(root, 'Build', 'Products', 'AgentDeviceRunner.xctestrun');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(xctestrunPath, '{}');
  const appBundlePath = seedProductBundle(
    root,
    path.join('Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app'),
  );
  const testBundleRelativePath = path.join('PlugIns', 'AgentDeviceRunnerUITests.xctest');
  const testBundlePath = seedProductBundle(
    root,
    path.join(
      'Build',
      'Products',
      'Debug-iphonesimulator',
      'Runner-Runner.app',
      testBundleRelativePath,
    ),
  );

  serveParsedPlist({
    // A top-level key the collector must ignore alongside the one string reference it carries.
    ContainerInfo: { SchemeName: 'AgentDeviceRunner' },
    TestConfigurationName: 'AgentDeviceRunnerUITests',
    ProductPaths: [
      '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app',
      // A nested non-string is not a product reference.
      ['__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app'],
    ],
    TestConfigurations: [
      {
        TestTargets: [
          {
            TestBundlePath:
              '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app/PlugIns/AgentDeviceRunnerUITests.xctest',
            TestHostPath: '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app',
            UITargetAppPath: '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app',
          },
        ],
      },
    ],
  });

  assert.deepEqual(await resolveExistingXctestrunProductPaths(xctestrunPath), [
    appBundlePath,
    testBundlePath,
  ]);
});

test('product-reference values of the wrong shape never resolve, and a configured target only needs to be a record to count', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const xctestrunPath = path.join(root, 'Build', 'Products', 'AgentDeviceRunner.xctestrun');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(xctestrunPath, '{}');
  const appBundlePath = seedProductBundle(
    root,
    path.join('Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app'),
  );
  // The surviving configured target names a product no other entry in this xctestrun names, so
  // its contribution is observable: dropping that target from the collection changes the result.
  const helperBundlePath = seedProductBundle(
    root,
    path.join('Build', 'Products', 'Debug-iphonesimulator', 'Helper.app'),
  );

  serveParsedPlist({
    // A legacy single-target map beside the malformed configuration list.
    AgentDeviceRunnerUITests: {
      TestBundlePath: '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app',
      // A number is neither a string reference nor an array to scan.
      ProductPaths: 42,
    },
    TestConfigurations: [
      'not-a-dict',
      7,
      {
        // TestTargets as a dict, not an array, contributes no target.
        TestTargets: { TestBundlePath: '__TESTROOT__/Missing.app' },
      },
      {
        // Non-record members of an array target list are filtered out; had this list been
        // collected unfiltered, the null member would make the reference scan throw instead of
        // contributing nothing.
        TestTargets: [null, 42, '__TESTROOT__/Also-Missing.app'],
      },
      {
        // The one record target: it carries no TestBundlePath and no name of its own, so only
        // being a record with a usable reference key is what makes its product resolve.
        TestTargets: [
          {
            DependentProductPaths: ['__TESTROOT__/Debug-iphonesimulator/Helper.app', 42, null],
          },
        ],
      },
    ],
  });

  // The legacy target's string TestBundlePath and the one well-formed dependent product each
  // resolve to their own seeded bundle; nothing the malformed shapes name can appear.
  const resolved = await resolveExistingXctestrunProductPaths(xctestrunPath);
  assert.deepEqual([...resolved!].sort(), [appBundlePath, helperBundlePath].sort());
});

test('an xctestrun whose parsed form names no product resolves to nothing', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const xctestrunPath = path.join(root, 'Build', 'Products', 'AgentDeviceRunner.xctestrun');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(xctestrunPath, '{}');

  serveParsedPlist({
    // A list-shaped TestConfigurations whose every entry is refused, and a target map with no
    // product-reference key at all: no reference string survives the collectors.
    ContainerInfo: { SchemeName: 'AgentDeviceRunner' },
    TestConfigurations: [{ TestTargets: [{}] }],
  });

  const resolved = await resolveExistingXctestrunProductPaths(xctestrunPath);
  assert.equal(resolved, null);
});

test('a configured product path that was never written to disk voids the whole xctestrun', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const xctestrunPath = path.join(root, 'Build', 'Products', 'AgentDeviceRunner.xctestrun');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(xctestrunPath, '{}');

  serveParsedPlist({
    TestConfigurations: [
      {
        TestTargets: [
          {
            TestBundlePath: '__TESTROOT__/Debug-iphonesimulator/Runner-Runner.app',
          },
        ],
      },
    ],
  });

  assert.equal(await resolveExistingXctestrunProductPaths(xctestrunPath), null);
});

test('a test-host-relative product resolves against the app bundle another target names, and is refused when no bundle carries it', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const xctestrunPath = path.join(root, 'Build', 'Products', 'AgentDeviceRunner.xctestrun');
  fs.mkdirSync(path.dirname(xctestrunPath), { recursive: true });
  fs.writeFileSync(xctestrunPath, '{}');
  const appBundlePath = seedProductBundle(
    root,
    path.join('Build', 'Products', 'Debug-macosx', 'Runner-Runner.app'),
  );
  const testBundlePath = path.join(
    appBundlePath,
    'Contents',
    'PlugIns',
    'AgentDeviceRunnerUITests.xctest',
  );
  fs.mkdirSync(testBundlePath, { recursive: true });

  serveParsedPlist({
    TestConfigurations: [
      {
        TestTargets: [
          {
            ProductPaths: ['__TESTROOT__/Debug-macosx/Runner-Runner.app'],
            // The host-relative lookup scans every .app root the TESTROOT references imply;
            // only the bundle that actually carries this relative path can resolve it.
            TestBundlePath: '__TESTHOST__/Contents/PlugIns/AgentDeviceRunnerUITests.xctest',
          },
        ],
      },
    ],
  });

  assert.deepEqual(await resolveExistingXctestrunProductPaths(xctestrunPath), [
    appBundlePath,
    testBundlePath,
  ]);

  // A host-relative reference no bundle under the test root carries voids the xctestrun.
  serveParsedPlist({
    TestConfigurations: [
      {
        TestTargets: [
          {
            ProductPaths: ['__TESTROOT__/Debug-macosx/Runner-Runner.app'],
            TestBundlePath: '__TESTHOST__/Contents/PlugIns/GhostTests.xctest',
          },
        ],
      },
    ],
  });

  assert.equal(await resolveExistingXctestrunProductPaths(xctestrunPath), null);
});

test('off macOS an xctestrun plutil cannot parse still resolves through the XML fallback, and on macOS the same file resolves to nothing', async () => {
  const root = mkdtempForTestSync('runner-xctestrun-products-');
  const productsRoot = path.join(root, 'Build', 'Products');
  const xctestrunPath = path.join(productsRoot, 'AgentDeviceRunner.xctestrun');
  const appBundlePath = seedProductBundle(
    root,
    path.join('Build', 'Products', 'Debug-iphonesimulator', 'Runner-Runner.app'),
  );
  writeXctestrunFixture(xctestrunPath, {
    projectRoot: root,
    productRelativePaths: ['Debug-iphonesimulator/Runner-Runner.app'],
  });

  // No plist decoder at all: the JSON read fails, so only the fallback can see the products.
  appleRunnerTestHost.update({
    readApplePlistJson: async () => null,
  });

  pretendPlatform('linux');
  assert.deepEqual(await resolveExistingXctestrunProductPaths(xctestrunPath), [appBundlePath]);

  // On macOS a plist plutil cannot parse marks the xctestrun unusable rather than letting the
  // text fallback mask a corrupt plist.
  pretendPlatform('darwin');
  assert.equal(await resolveExistingXctestrunProductPaths(xctestrunPath), null);
});

test('off macOS an unreadable xctestrun file resolves to nothing instead of throwing', async () => {
  pretendPlatform('linux');
  const missing = path.join(mkdtempForTestSync('runner-xctestrun-products-'), 'absent.xctestrun');

  appleRunnerTestHost.update({
    readApplePlistJson: async () => null,
  });

  assert.equal(await resolveExistingXctestrunProductPaths(missing), null);
});
