import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { test } from 'vitest';
import {
  DOCUMENTED_PACK_STUBS,
  MACOS_HELPER_PACK_ROOT,
  macosHelperPackFailures,
  readMacosHelperTestTargets,
} from '../../scripts/lib/macos-helper-pack.mjs';

// The `@agent-device/macos` package ships `macos-helper` and builds it on the user's machine. Its
// manifest declares the test targets, and `files` ships only each target's PackStub.swift: SwiftPM
// refuses any load of a package whose declared test target has no sources, so the stubs are what
// keep the install-time `swift build` of the packed tree alive while the real tests stay out of the
// tarball. That forces the whole package — sources, tests, and manifest — into one directory,
// which keeps every tool that copies the tree (Stryker's sandbox, coverage gates, Windows
// checkouts) away from directory symlinks. Nothing else verifies the packed tree compiles — its
// first consumer is a user's machine — so these guards hold the layout against the real pack list,
// not the `files` text.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = path.join(repoRoot, 'packages/platform-macos');
const helperRoot = path.join(packageRoot, MACOS_HELPER_PACK_ROOT);
const shippedManifestPath = path.join(helperRoot, 'Package.swift');

function shippedManifest(): string {
  return fs.readFileSync(shippedManifestPath, 'utf8');
}

function declaredTargetNames(manifest: string, kind: 'target' | 'executableTarget'): string[] {
  return [
    ...manifest.matchAll(new RegExp(String.raw`\.${kind}\(\s*name:\s*"([^"]+)"`, 'g')),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function packedPaths(root: string): string[] {
  // runCmdSync resolves `npm` through the PATH extensions a Windows checkout needs; a bare
  // execFileSync('npm', ...) there dies on ENOENT for npm.cmd.
  const result = runCmdSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout);
  const pack: { files?: { path?: unknown }[] } = Array.isArray(parsed) ? parsed[0] : parsed;
  return pack.files?.map((entry) => String(entry.path)) ?? [];
}

test('the shipped macOS helper manifest declares the helper and its test targets', () => {
  const manifest = shippedManifest();
  assert.deepEqual(declaredTargetNames(manifest, 'target'), ['AgentDeviceMacOSInput']);
  assert.deepEqual(declaredTargetNames(manifest, 'executableTarget'), ['AgentDeviceMacOSHelper']);
  assert.deepEqual(readMacosHelperTestTargets(manifest).sort(), [
    'AgentDeviceMacOSHelperTests',
    'AgentDeviceMacOSInputTests',
  ]);
  assert.match(manifest, /\.executable\(\s*name:\s*"agent-device-macos-helper"/);
});

test('every declared test target holds at least one real test in the checkout', () => {
  for (const name of readMacosHelperTestTargets(shippedManifest())) {
    const sources = fs.readdirSync(path.join(helperRoot, 'Tests', name));
    assert.ok(
      sources.some((file) => file !== 'PackStub.swift' && file.endsWith('.swift')),
      `${name} must hold real tests in the checkout or the lane would cover nothing`,
    );
  }
});

test('the macOS plugin pack is a buildable helper package with one PackStub.swift per test target', () => {
  const paths = packedPaths(packageRoot);
  // Behavior, not config text: whatever `files` says, the tarball itself must carry the manifest,
  // the sources and exactly the stubs — a missing stub breaks the install-time `swift build`, an
  // extra test source ships dead tests.
  assert.deepEqual(macosHelperPackFailures(paths, shippedManifest()), []);
  assert.deepEqual(
    paths.filter((entryPath) => entryPath.startsWith(`${MACOS_HELPER_PACK_ROOT}/Tests/`)).sort(),
    [...DOCUMENTED_PACK_STUBS].sort(),
  );
});

test('the core pack carries no macOS helper', () => {
  assert.deepEqual(
    packedPaths(repoRoot).filter((entryPath) => /(?:^|\/)macos-helper(?:\/|$)/.test(entryPath)),
    [],
  );
});

// The failure direction: the pack check can only ever watch a healthy package pass, so each rule is
// exercised here against a fixture path list.
const manifestSource = [
  '.testTarget(',
  '  name: "AgentDeviceMacOSHelperTests",',
  '.testTarget(',
  '  name: "AgentDeviceMacOSInputTests",',
].join('\n');
const healthyPack = [
  'package.json',
  'dist/agent-device.mjs',
  'macos-helper/Package.swift',
  'macos-helper/Sources/AgentDeviceMacOSHelper/main.swift',
  ...DOCUMENTED_PACK_STUBS,
];

test('the helper pack rules name each way a packed helper tree cannot build', () => {
  assert.deepEqual(macosHelperPackFailures(healthyPack, manifestSource), []);
  const without = (dropped: string) => healthyPack.filter((entryPath) => entryPath !== dropped);
  const failuresOf = (paths: string[], manifest = manifestSource) =>
    macosHelperPackFailures(paths, manifest).join('\n');

  // Each declared test target needs its PackStub.swift or the install-time `swift build` dies.
  assert.match(
    failuresOf(without('macos-helper/Tests/AgentDeviceMacOSInputTests/PackStub.swift')),
    /pack stubs: macos-helper\/Tests\/AgentDeviceMacOSInputTests\/PackStub\.swift/,
  );
  assert.match(
    failuresOf([
      ...healthyPack,
      'macos-helper/Tests/AgentDeviceMacOSInputTests/ScheduleTests.swift',
    ]),
    /macOS helper test sources/,
  );
  // A stub path the declared list does not name is a test source, not an exemption.
  assert.match(
    failuresOf([...healthyPack, 'macos-helper/Tests/AgentDeviceSneakyTests/PackStub.swift']),
    /test sources: macos-helper\/Tests\/AgentDeviceSneakyTests\/PackStub\.swift/,
  );
  // A declared stub whose target left the manifest is a dead stub riding in the pack.
  assert.match(
    failuresOf(healthyPack, ['.testTarget(', '  name: "AgentDeviceMacOSInputTests",'].join('\n')),
    /no test target declares: macos-helper\/Tests\/AgentDeviceMacOSHelperTests\/PackStub\.swift/,
  );
  assert.match(failuresOf(without('macos-helper/Package.swift')), /no macOS helper Package\.swift/);
  assert.match(
    failuresOf(without('macos-helper/Sources/AgentDeviceMacOSHelper/main.swift')),
    /manifest without its sources/,
  );
  assert.match(
    failuresOf([...healthyPack, 'macos-helper/.build/release/agent-device-macos-helper']),
    /build output/,
  );
});
