import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export const SNAPSHOT_BRIDGE_ASSET_PATHS = Object.freeze([
  'apple/snapshot-bridge/SnapshotBridge.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.h',
  'apple/snapshot-bridge/SnapshotBridgeCapture.m',
  'apple/snapshot-bridge/ForegroundApplicationGeometry.h',
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

/**
 * The heading that opens a numbered license section. The renderer writes every attribution it
 * produces before the first one, so this line is also the boundary between the attributions the
 * gate reads and the license text it preserves.
 */
const LICENSE_SECTION_HEADING = /^\[(\d+)\]$/;

/**
 * The ids of the numbered license sections that hold text. A section runs from its `[n]` heading to
 * the next heading, so a license whose body carries blank lines keeps that body. A line shaped like a
 * heading inside a license body only shortens the section it sits in; it cannot fill an empty one.
 */
function readLicenseTextIds(lines) {
  const idsWithText = new Set();
  let openId;
  let seenText = false;
  for (const line of lines) {
    const heading = line.match(LICENSE_SECTION_HEADING);
    if (heading) {
      if (seenText) idsWithText.add(openId);
      openId = Number(heading[1]);
      seenText = false;
    } else if (openId !== undefined && line.trim()) {
      seenText = true;
    }
  }
  if (seenText) idsWithText.add(openId);
  return idsWithText;
}

/**
 * The lines the attributions can live on: everything before the first numbered section, which is the
 * block the renderer writes first. A section holds a dependency's license or NOTICE text verbatim —
 * the renderer neither escapes nor indents it — so its content is upstream's, and prose there can
 * carry a contact address or a pointer to "section [9]" shaped like an attribution line. Reading
 * those as attributions would reject publishable bytes, and one such line would stand in for the
 * real attributions a build failed to write.
 */
function readAttributionLines(lines) {
  const firstSection = lines.findIndex((line) => LICENSE_SECTION_HEADING.test(line));
  return firstSection === -1 ? lines : lines.slice(0, firstSection);
}

/**
 * The `name@version (license): [n]` line the bundler writes, or undefined for any other line. The
 * license field is whatever the plugin reports, wrapped in the renderer's own parentheses, so a
 * grouped SPDX expression like `(MIT OR (Apache-2.0 AND CC0-1.0))` nests inside it: the field ends
 * at the first `):` boundary, which only that closing parenthesis can reach. What follows the colon
 * up to the renderer's optional `; Author: ` clause is the reference list — one package names
 * several ids when it ships a NOTICE or source-file notices with its license. The author clause is
 * attribution metadata: an author field holding a bracketed footnote must not read as a license
 * reference, in either direction.
 */
function readAttribution(line) {
  const attribution = line.match(/^(\S+@\S+ \((.+?)\)): ?(.*)$/);
  if (!attribution) return undefined;
  const references = attribution[3].split('; Author: ', 1)[0];
  return {
    label: attribution[1],
    references: [...references.matchAll(/\[(\d+)\]/g)].map((reference) => Number(reference[1])),
  };
}

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
  const lines = contents.replaceAll('\r\n', '\n').split('\n');
  const licenseTextIds = readLicenseTextIds(lines);
  const attributions = readAttributionLines(lines)
    .map(readAttribution)
    .filter((attribution) => attribution !== undefined);
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
    const expectedStubs = new Set(
      readMacosHelperTestTargets(manifestSource).map(
        (target) => `apple/macos-helper/Tests/${target}/PackStub.swift`,
      ),
    );
    const missingStubs = [...expectedStubs].filter((stubPath) => !paths.includes(stubPath));
    if (missingStubs.length > 0) {
      throw new Error(
        `npm pack is missing macOS helper test-target pack stubs: ${missingStubs.join(', ')}`,
      );
    }
    // The other direction: a declared stub whose target left the manifest stays exempt from the
    // path guard above, so compare against the manifest set here. A target removed or renamed
    // without retiring its package.json `files` entry and its DOCUMENTED_PACK_STUBS declaration
    // would otherwise ship a dead stub forever.
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
