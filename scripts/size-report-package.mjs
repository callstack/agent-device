import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export const SNAPSHOT_BRIDGE_ASSET_PATHS = Object.freeze([
  'apple/snapshot-bridge/SnapshotBridge.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.m',
]);

export function assertSnapshotBridgeAssets(presentPaths, context) {
  const present = new Set(presentPaths);
  const missing = SNAPSHOT_BRIDGE_ASSET_PATHS.filter((assetPath) => !present.has(assetPath));
  if (missing.length > 0) {
    throw new Error(`${context} is missing: ${missing.join(', ')}`);
  }
}

/**
 * The test targets the macOS helper manifest declares — the one reading of "which test targets
 * exist". SwiftPM refuses to load a package whose declared test target has no sources, so each
 * name here must appear in the pack as `apple/macos-helper/Tests/<name>/PackStub.swift`.
 */
export function readMacosHelperTestTargets(manifestSource) {
  return [...manifestSource.matchAll(/\.testTarget\(\s*name:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/**
 * The macOS helper's pack stubs: the only paths under a `Tests/` directory the package may carry.
 * SwiftPM refuses to resolve a declared test target without sources, so `files` ships exactly one
 * stub per target; a new target's stub must be declared here, in the failing direction. One owner
 * for both decisions this list governs: the publish check in this file, and the package-wide
 * no-test-code path guard, which imports it (scripts/lib/shipped-test-code.ts).
 */
export const DOCUMENTED_PACK_STUBS = Object.freeze([
  'apple/macos-helper/Tests/AgentDeviceMacOSHelperTests/PackStub.swift',
  'apple/macos-helper/Tests/AgentDeviceMacOSInputTests/PackStub.swift',
]);

export function collectNpmPack(root) {
  const cachePath = path.join(root, '.tmp', 'npm-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const stdout = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', cachePath, '--cache', cachePath],
    { cwd: root, encoding: 'utf8' },
  );
  const pack = parseNpmPackOutput(stdout);
  const entries = normalizeNpmPackEntries(pack);
  assertPublishPackageContents(entries, {
    repoRoot: root,
    requireSnapshotBridge: fs.existsSync(path.join(root, 'apple', 'snapshot-bridge')),
  });
  return {
    filename: pack.filename,
    tarballPath: path.join(cachePath, pack.filename),
    tarballBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    files: entries.length,
    entries,
  };
}

export function assertPublishPackageContents(entries, options = {}) {
  const paths = entries.map((entry) => entry.path);
  const requiredAssets = [
    { directory: 'android/snapshot-helper/dist/', suffix: '.apk' },
    { directory: 'android/snapshot-helper/dist/', suffix: '.manifest.json' },
    { directory: 'android/ime-helper/dist/', suffix: '.apk' },
    { directory: 'android/ime-helper/dist/', suffix: '.manifest.json' },
  ];
  if (
    options.requireSnapshotBridge ??
    paths.some((entryPath) => entryPath.startsWith('apple/snapshot-bridge/'))
  ) {
    assertSnapshotBridgeAssets(
      paths.filter((entryPath) => SNAPSHOT_BRIDGE_ASSET_PATHS.includes(entryPath)),
      'npm pack snapshot bridge',
    );
  }
  const missingAssets = requiredAssets.filter(
    (asset) =>
      !paths.some(
        (entryPath) => entryPath.startsWith(asset.directory) && entryPath.endsWith(asset.suffix),
      ),
  );
  if (missingAssets.length > 0) {
    throw new Error(
      `npm pack is missing publish assets: ${missingAssets
        .map((asset) => `${asset.directory}*${asset.suffix}`)
        .join(', ')}`,
    );
  }
  const forbiddenPaths = paths.filter(
    (entryPath) => entryPath === 'scripts' || entryPath.startsWith('scripts/'),
  );
  if (forbiddenPaths.length > 0) {
    throw new Error(`npm pack includes benchmark or build scripts: ${forbiddenPaths.join(', ')}`);
  }
  // The macOS helper ships as buildable source. Its manifest declares the test targets, so the
  // packed tree must hold at least one source per target or the install-time `swift build` dies;
  // `files` ships exactly the stubs DOCUMENTED_PACK_STUBS declares and excludes every other test
  // source. Anything else under Tests/ in the pack means the exclusion list leaked real tests.
  const documentedStubPaths = new Set(DOCUMENTED_PACK_STUBS);
  const shippedSwiftTests = paths.filter(
    (entryPath) =>
      (entryPath === 'apple/macos-helper/Tests' ||
        entryPath.startsWith('apple/macos-helper/Tests/')) &&
      !documentedStubPaths.has(entryPath),
  );
  if (shippedSwiftTests.length > 0) {
    throw new Error(`npm pack includes macOS helper test sources: ${shippedSwiftTests.join(', ')}`);
  }
  // Helper sources without the manifest are not a buildable Swift package, so a dropped
  // `files` entry that ships Sources but not Package.swift must fail here, not on the user's
  // machine. With the manifest present, read the target list from it — the pack and the
  // manifest can then never drift onto different target sets.
  if (paths.some((entryPath) => entryPath.startsWith('apple/macos-helper/Sources/'))) {
    if (!paths.includes('apple/macos-helper/Package.swift')) {
      throw new Error('npm pack ships macOS helper sources without its Package.swift');
    }
  }
  if (paths.includes('apple/macos-helper/Package.swift')) {
    const manifestSource =
      options.macosHelperManifestSource ??
      fs.readFileSync(
        path.join(options.repoRoot ?? process.cwd(), 'apple/macos-helper/Package.swift'),
        'utf8',
      );
    const testTargets = readMacosHelperTestTargets(manifestSource);
    const missingStubs = testTargets.filter(
      (target) => !paths.includes(`apple/macos-helper/Tests/${target}/PackStub.swift`),
    );
    if (missingStubs.length > 0) {
      throw new Error(
        `npm pack is missing macOS helper test-target pack stubs: ${missingStubs
          .map((target) => `apple/macos-helper/Tests/${target}/PackStub.swift`)
          .join(', ')}`,
      );
    }
    // The other direction: a declared stub whose target left the manifest stays exempt from the
    // path guard above, so compare against the manifest set here. A target removed or renamed
    // without retiring its package.json `files` entry and its DOCUMENTED_PACK_STUBS declaration
    // would otherwise ship a dead stub forever.
    const expectedStubs = new Set(
      testTargets.map((target) => `apple/macos-helper/Tests/${target}/PackStub.swift`),
    );
    const staleStubs = [...documentedStubPaths].filter(
      (stubPath) => paths.includes(stubPath) && !expectedStubs.has(stubPath),
    );
    if (staleStubs.length > 0) {
      throw new Error(
        `npm pack ships documented pack stubs no test target declares: ${staleStubs.join(', ')}`,
      );
    }
  }
}

function parseNpmPackOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function normalizeNpmPackEntries(pack) {
  if (!Array.isArray(pack.files)) {
    throw new Error('npm pack did not return per-file path/size data in files[]');
  }
  return pack.files.map((entry) => {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error(`npm pack returned an invalid file entry: ${JSON.stringify(entry)}`);
    }
    return { path: entry.path, size: entry.size };
  });
}
