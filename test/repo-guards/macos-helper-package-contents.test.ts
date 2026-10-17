import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import { test } from 'vitest';
import { readMacosHelperTestTargets } from '../../scripts/size-report-package.mjs';

// The npm package ships `apple/macos-helper` and builds it on the user's machine. Its manifest
// declares the test targets, and `files` ships only each target's PackStub.swift: SwiftPM refuses
// any load of a package whose declared test target has no sources, so the stubs are what keep the
// install-time `swift build` of the packed tree alive while the real tests stay out of the
// tarball. That forces the whole package — sources, tests, and manifest — into one directory,
// which keeps every tool that copies the tree (Stryker's sandbox, coverage gates, Windows
// checkouts) away from directory symlinks. Nothing else verifies the packed tree compiles — its
// first consumer is a user's machine — so these guards hold the layout against the real pack list,
// not the `files` text.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperRoot = path.join(repoRoot, 'apple/macos-helper');
const shippedManifestPath = path.join(helperRoot, 'Package.swift');

function shippedManifest(): string {
  return fs.readFileSync(shippedManifestPath, 'utf8');
}

function declaredTargetNames(manifest: string, kind: 'target' | 'executableTarget'): string[] {
  return [
    ...manifest.matchAll(new RegExp(String.raw`\.${kind}\(\s*name:\s*"([^"]+)"`, 'g')),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function packedPaths(): string[] {
  // runCmdSync resolves `npm` through the PATH extensions a Windows checkout needs; a bare
  // execFileSync('npm', ...) there dies on ENOENT for npm.cmd.
  const result = runCmdSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
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

test('the pack ships one PackStub.swift per declared test target and no other test source', () => {
  const paths = packedPaths();
  const testTargetPaths = paths.filter((entryPath) =>
    entryPath.startsWith('apple/macos-helper/Tests/'),
  );
  // Behavior, not config text: whatever `files` says, the tarball itself must carry exactly the
  // stubs — a missing one breaks the install-time `swift build`, an extra one ships dead tests.
  const expected = readMacosHelperTestTargets(shippedManifest())
    .map((target) => `apple/macos-helper/Tests/${target}/PackStub.swift`)
    .sort();
  assert.deepEqual([...testTargetPaths].sort(), expected);
});
