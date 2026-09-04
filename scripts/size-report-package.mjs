import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatBytes,
  formatDiff,
  formatMaybeBytes,
  formatSignedBytes,
} from './size-report-format.mjs';

export const SNAPSHOT_BRIDGE_ASSET_PATHS = Object.freeze([
  'apple/snapshot-bridge/SnapshotBridge.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
  'apple/snapshot-bridge/SnapshotBridgeRuntime.h',
]);

export function assertSnapshotBridgeAssets(presentPaths, context) {
  const present = new Set(presentPaths);
  const missing = SNAPSHOT_BRIDGE_ASSET_PATHS.filter((assetPath) => !present.has(assetPath));
  if (missing.length > 0) {
    throw new Error(`${context} is missing: ${missing.join(', ')}`);
  }
}

const PACKAGE_COMPONENTS = [
  {
    id: 'js',
    label: 'JS / dist source',
    matches: (entryPath) => entryPath === 'dist/src' || entryPath.startsWith('dist/src/'),
  },
  {
    id: 'apple-runner',
    label: 'Apple runner source/project',
    matches: (entryPath) =>
      entryPath === 'dist/apple/runner' || entryPath.startsWith('dist/apple/runner/'),
  },
  {
    id: 'apple-snapshot-presentation',
    label: 'Apple snapshot presentation source',
    matches: (entryPath) =>
      entryPath === 'dist/apple/snapshot-presentation' ||
      entryPath.startsWith('dist/apple/snapshot-presentation/'),
  },
  {
    id: 'apple-snapshot-bridge',
    label: 'Apple Simulator snapshot bridge source',
    matches: (entryPath) =>
      entryPath === 'apple/snapshot-bridge' || entryPath.startsWith('apple/snapshot-bridge/'),
  },
  {
    id: 'macos-helper',
    label: 'macOS helper source',
    matches: (entryPath) =>
      entryPath === 'apple/macos-helper' || entryPath.startsWith('apple/macos-helper/'),
  },
  {
    id: 'android-helpers',
    label: 'Android helper artifacts',
    matches: (entryPath) =>
      /^android\/(?:snapshot-helper|ime-helper)\/dist(?:\/|$)/.test(entryPath),
  },
  { id: 'other', label: 'Other package files' },
];

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
    requireSnapshotBridge: fs.existsSync(path.join(root, 'apple', 'snapshot-bridge')),
  });
  return {
    filename: pack.filename,
    tarballPath: path.join(cachePath, pack.filename),
    tarballBytes: pack.size,
    unpackedBytes: pack.unpackedSize,
    files: entries.length,
    entries,
    components: summarizeEntries(pack.unpackedSize, entries),
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
  const missingAssets = requiredAssets.filter((asset) =>
    asset.path
      ? !paths.includes(asset.path)
      : !paths.some(
          (entryPath) => entryPath.startsWith(asset.directory) && entryPath.endsWith(asset.suffix),
        ),
  );
  if (missingAssets.length > 0) {
    throw new Error(
      `npm pack is missing publish assets: ${missingAssets
        .map((asset) => asset.path ?? `${asset.directory}*${asset.suffix}`)
        .join(', ')}`,
    );
  }
  const forbiddenPaths = paths.filter(
    (entryPath) => entryPath === 'scripts' || entryPath.startsWith('scripts/'),
  );
  if (forbiddenPaths.length > 0) {
    throw new Error(`npm pack includes benchmark or build scripts: ${forbiddenPaths.join(', ')}`);
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

export function classifyNpmPackEntry(entry) {
  const matches = PACKAGE_COMPONENTS.filter((component) => component.matches?.(entry.path));
  if (matches.length > 1) {
    throw new Error(
      `Package entry ${JSON.stringify(entry.path)} matched ${matches.length} size components`,
    );
  }
  return { ...entry, component: matches[0]?.id ?? 'other' };
}

export function summarizeNpmPackComponents(pack) {
  return summarizeEntries(pack.unpackedSize, normalizeNpmPackEntries(pack));
}

function summarizeEntries(unpackedSize, entries) {
  if (!Number.isSafeInteger(unpackedSize) || unpackedSize < 0) {
    throw new Error(`npm pack returned an invalid unpackedSize: ${unpackedSize}`);
  }
  const totals = new Map(
    PACKAGE_COMPONENTS.map((component) => [component.id, { files: 0, unpackedBytes: 0 }]),
  );
  for (const entry of entries.map(classifyNpmPackEntry)) {
    const total = totals.get(entry.component);
    total.files += 1;
    total.unpackedBytes += entry.size;
  }
  const components = PACKAGE_COMPONENTS.map((component) => ({
    id: component.id,
    label: component.label,
    ...totals.get(component.id),
  }));
  const componentBytes = components.reduce(
    (total, component) => total + component.unpackedBytes,
    0,
  );
  if (componentBytes !== unpackedSize) {
    throw new Error(
      `Package component byte sum ${componentBytes} does not match npm pack unpackedSize ${unpackedSize}`,
    );
  }
  return components;
}

export function formatPackageComponents(currentPack, basePack) {
  const currentById = new Map(
    (currentPack.components ?? []).map((component) => [component.id, component]),
  );
  const baseById = new Map(
    (basePack?.components ?? []).map((component) => [component.id, component]),
  );
  const rows = PACKAGE_COMPONENTS.map((component) => {
    const current = currentById.get(component.id)?.unpackedBytes ?? 0;
    const base = baseById.get(component.id)?.unpackedBytes;
    return `| ${component.label} | ${formatMaybeBytes(base)} | ${formatBytes(current)} | ${formatDiff(base, current)} |`;
  });
  return `### npm unpacked components

| Component | Base | Current | Diff |
|---|---:|---:|---:|
${rows.join('\n')}
`;
}

export function formatPackedFiles(currentEntries, baseEntries) {
  if (!baseEntries) return formatTopPackedFiles(currentEntries);
  const currentByPath = new Map(currentEntries.map((entry) => [entry.path, entry.size]));
  const baseByPath = new Map(baseEntries.map((entry) => [entry.path, entry.size]));
  const paths = new Set([...currentByPath.keys(), ...baseByPath.keys()]);
  const rows = [...paths]
    .map((filePath) => {
      const current = currentByPath.get(filePath) ?? 0;
      const base = baseByPath.get(filePath) ?? 0;
      return { path: filePath, base, current, diff: current - base };
    })
    .filter((entry) => entry.diff !== 0)
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff))
    .slice(0, 10)
    .map(
      (entry) =>
        `| \`${entry.path}\` | ${formatBytes(entry.base)} | ${formatBytes(entry.current)} | ${formatSignedBytes(entry.diff)} |`,
    );
  if (rows.length === 0) {
    return '### Top changed packed files\n\nNo changed packed files.\n';
  }
  return `### Top changed packed files

| Packed file | Base | Current | Diff |
|---|---:|---:|---:|
${rows.join('\n')}
`;
}

function formatTopPackedFiles(entries) {
  const rows = [...entries]
    .sort((left, right) => right.size - left.size)
    .slice(0, 10)
    .map((entry) => `| \`${entry.path}\` | ${formatBytes(entry.size)} |`);
  return `### Top packed files

| Packed file | Unpacked |
|---|---:|
${rows.join('\n')}
`;
}
