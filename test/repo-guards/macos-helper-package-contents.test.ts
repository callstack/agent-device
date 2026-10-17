import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// The npm package ships `apple/macos-helper` and builds it on the user's machine. Its manifest
// declares the test targets, and `files` ships only each target's PackStub.swift: SwiftPM refuses
// any load of a package whose declared test target has no sources, so the stubs are what keep the
// install-time `swift build` of the packed tree alive while the real tests stay out of the
// tarball. That forces the whole package — sources, tests, and manifest — into one directory,
// which keeps every tool that copies the tree (Stryker's sandbox, coverage gates, Windows
// checkouts) away from directory symlinks. Nothing else verifies the packed tree compiles — its
// first consumer is a user's machine — so these guards hold the layout.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helperRoot = path.join(repoRoot, 'apple/macos-helper');
const shippedManifestPath = path.join(helperRoot, 'Package.swift');

function declaredTargetNames(
  manifest: string,
  kind: 'target' | 'executableTarget' | 'testTarget',
): string[] {
  return [
    ...manifest.matchAll(new RegExp(String.raw`\.${kind}\(\s*name:\s*"([^"]+)"`, 'g')),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

test('the shipped macOS helper manifest declares the helper and its test targets', () => {
  const manifest = fs.readFileSync(shippedManifestPath, 'utf8');
  assert.deepEqual(declaredTargetNames(manifest, 'target'), ['AgentDeviceMacOSInput']);
  assert.deepEqual(declaredTargetNames(manifest, 'executableTarget'), ['AgentDeviceMacOSHelper']);
  assert.deepEqual(declaredTargetNames(manifest, 'testTarget').sort(), [
    'AgentDeviceMacOSHelperTests',
    'AgentDeviceMacOSInputTests',
  ]);
  assert.match(manifest, /\.executable\(\s*name:\s*"agent-device-macos-helper"/);
});

test('every declared test target holds a pack stub and at least one real test', () => {
  const manifest = fs.readFileSync(shippedManifestPath, 'utf8');
  for (const name of declaredTargetNames(manifest, 'testTarget')) {
    const targetDir = path.join(helperRoot, 'Tests', name);
    const sources = fs.readdirSync(targetDir);
    assert.ok(
      sources.includes('PackStub.swift'),
      `${name} must ship a PackStub.swift or the packed tree will not load`,
    );
    assert.ok(
      sources.some((file) => file !== 'PackStub.swift' && file.endsWith('.swift')),
      `${name} must hold real tests in the checkout or the lane would cover nothing`,
    );
  }
});
