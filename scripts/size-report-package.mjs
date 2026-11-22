import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readLicenseNotices } from './size-report-package-notices.mjs';
export const SNAPSHOT_BRIDGE_ASSET_PATHS = Object.freeze([
  'apple/snapshot-bridge/SnapshotBridge.m',
  'apple/snapshot-bridge/SnapshotBridgeRequest.h',
  'apple/snapshot-bridge/SnapshotBridgeRequest.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.m',
  'apple/snapshot-bridge/SnapshotBridgeSurfaceHosts.h',
  'apple/snapshot-bridge/SnapshotBridgeSurfaceHosts.m',
  'apple/snapshot-bridge/ForegroundApplicationGeometry.h',
]);

export function assertSnapshotBridgeAssets(presentPaths, context) {
  const present = new Set(presentPaths);
  const missing = SNAPSHOT_BRIDGE_ASSET_PATHS.filter((assetPath) => !present.has(assetPath));
  if (missing.length > 0) {
    throw new Error(`${context} is missing: ${missing.join(', ')}`);
  }
}

export function collectNpmPack(root) {
  const cachePath = path.join(root, '.tmp', 'npm-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const stdout = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', cachePath, '--cache', cachePath],
    { cwd: root, encoding: 'utf8' },
  );
  const pack = parseNpmPackOutput(stdout);
  const entries = pack.files;
  assertPublishPackageContents(entries, {
    noticesRoot: root,
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

/**
 * The notices asset a packed tree ships, and the build output it comes from. One path keeps the
 * manifest check and the content check naming the same file.
 */
const BUNDLED_LICENSE_NOTICES_PATH = 'dist/src/THIRD_PARTY_NOTICES.txt';

function describeUnresolvedAttribution(attribution) {
  return (
    `${attribution.label} -> ` +
    (attribution.references.length > 0
      ? `[${attribution.references.join('], [')}]`
      : 'no reference')
  );
}

/**
 * The published CLI bundles its runtime dependencies into `dist`, so the notices it ships must name
 * them and carry the terms behind every name: each `name@version (license): [n]` attribution must
 * point at a numbered section that holds text. The bundler's zero-dependency output — the generic
 * "nothing bundled" line — names nobody, and a file of bare `[n]` headings has the right shape with
 * no license terms in it, so a build that stopped bundling dependencies, or wrote headings without
 * bodies, would otherwise keep clearing a gate that only counts the two kinds of line.
 *
 * This is the published CLI's policy, not the bundler's: a project that genuinely bundles nothing
 * still gets the generic notice, and only this package is held to naming somebody.
 */
function assertLicenseNoticeContents(contents, context) {
  const { attributions, licenseTextIds } = readLicenseNotices(contents);
  const unresolved = attributions.filter(
    (attribution) =>
      attribution.references.length === 0 ||
      attribution.references.some((reference) => !licenseTextIds.has(reference)),
  );
  if (attributions.length > 0 && unresolved.length === 0) return;
  throw new Error(
    `${context} ships ${BUNDLED_LICENSE_NOTICES_PATH} with no bundled dependency notices: ` +
      `expected every "name@version (license): [n]" attribution to reference a non-empty license ` +
      `text, found ${attributions.length} attributions and ${licenseTextIds.size} license texts` +
      (unresolved.length > 0
        ? `; unresolved: ${unresolved.map(describeUnresolvedAttribution).join('; ')}`
        : '') +
      '.',
  );
}

/**
 * Requires the notices asset the `npm pack` manifest declares, and — when `noticesRoot` names the tree
 * that was packed or installed — that its contents attribute somebody. A manifest says only that a
 * path exists and how many bytes it is, which the bundler's zero-dependency placeholder satisfies;
 * reading the bytes is what lets the gate see the attribution a user actually receives. A tree without
 * the file fails naming the path, rather than with a bare ENOENT from a read.
 */
export function assertBundledLicenseNotices(entries, options = {}) {
  if (!entries.some((entry) => entry.path === BUNDLED_LICENSE_NOTICES_PATH && entry.size > 0)) {
    throw new Error(`npm pack is missing non-empty ${BUNDLED_LICENSE_NOTICES_PATH}`);
  }
  if (!options.noticesRoot) return;
  const noticesPath = path.join(options.noticesRoot, BUNDLED_LICENSE_NOTICES_PATH);
  const context = options.context ?? options.noticesRoot;
  if (!fs.existsSync(noticesPath)) {
    throw new Error(`${context} has no ${BUNDLED_LICENSE_NOTICES_PATH}.`);
  }
  assertLicenseNoticeContents(fs.readFileSync(noticesPath, 'utf8'), context);
}

export function assertPublishPackageContents(entries, options = {}) {
  assertBundledLicenseNotices(entries, {
    noticesRoot: options.noticesRoot,
    context: options.noticesRoot ? `npm pack of ${options.noticesRoot}` : undefined,
  });
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
  // macOS desktop automation and its Swift helper ship in the `@agent-device/macos` plugin. A
  // helper path here means a `files` entry put the plugin's source back into the core.
  const helperPaths = paths.filter((entryPath) => /(?:^|\/)macos-helper(?:\/|$)/.test(entryPath));
  if (helperPaths.length > 0) {
    throw new Error(
      `npm pack includes the macOS helper, which @agent-device/macos ships: ${helperPaths.join(', ')}`,
    );
  }
}

export function parseNpmPackOutput(stdout) {
  const parsed = JSON.parse(stdout);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack || typeof pack.filename !== 'string' || pack.filename.length === 0) {
    throw new Error('npm pack did not return a filename');
  }
  for (const field of ['size', 'unpackedSize']) {
    if (!Number.isSafeInteger(pack[field]) || pack[field] < 0) {
      throw new Error(`npm pack returned an invalid ${field}: ${JSON.stringify(pack[field])}`);
    }
  }
  return { ...pack, files: normalizeNpmPackEntries(pack) };
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
