import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// The npm package ships `apple/macos-helper` and builds it on the user's machine, so its manifest
// may declare only the targets whose sources ship. SwiftPM refuses any build of such a package —
// including the install-time `swift build` — once a declared test target's directory is missing,
// which is what keeps the helper's tests from leaving the tarball through `files` alone. The test
// targets belong to `apple/macos-helper-tests`, a development package that compiles the same
// sources through its `Sources` symlink. Nothing in the repo compiles the shipped manifest's
// target list — its first consumer is a user's machine — so these guards hold the split.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shippedManifestPath = path.join(repoRoot, 'apple/macos-helper/Package.swift');
const testPackageRoot = path.join(repoRoot, 'apple/macos-helper-tests');

function declaredTargetNames(
  manifest: string,
  kind: 'target' | 'executableTarget' | 'testTarget',
): string[] {
  return [
    ...manifest.matchAll(new RegExp(String.raw`\.${kind}\(\s*name:\s*"([^"]+)"`, 'g')),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function shippedManifest(): string {
  return fs.readFileSync(shippedManifestPath, 'utf8');
}

function testManifest(): string {
  return fs.readFileSync(path.join(testPackageRoot, 'Package.swift'), 'utf8');
}

test('the shipped macOS helper manifest declares no test targets', () => {
  const manifest = shippedManifest();
  assert.doesNotMatch(manifest, /\.testTarget\(/);
  assert.deepEqual(declaredTargetNames(manifest, 'target'), ['AgentDeviceMacOSInput']);
  assert.deepEqual(declaredTargetNames(manifest, 'executableTarget'), ['AgentDeviceMacOSHelper']);
  assert.match(manifest, /\.executable\(\s*name:\s*"agent-device-macos-helper"/);
});

test('the macOS helper test package compiles the shipped sources and owns the test targets', () => {
  const manifest = testManifest();
  assert.equal(
    fs.readlinkSync(path.join(testPackageRoot, 'Sources')),
    path.join('..', 'macos-helper', 'Sources'),
    'the test package must compile the shipped sources, not a copy',
  );
  assert.ok(
    fs.existsSync(path.join(testPackageRoot, 'Sources/AgentDeviceMacOSHelper/main.swift')),
    'the Sources symlink must resolve into the shipped helper sources',
  );

  // Every target the shipped manifest builds must exist here too, or the tests would cover a
  // tree users never compile.
  const shippedTargets = [
    ...declaredTargetNames(shippedManifest(), 'target'),
    ...declaredTargetNames(shippedManifest(), 'executableTarget'),
  ];
  const testPackageTargets = [
    ...declaredTargetNames(manifest, 'target'),
    ...declaredTargetNames(manifest, 'executableTarget'),
  ];
  for (const name of shippedTargets) {
    assert.ok(testPackageTargets.includes(name), `the test package must build ${name}`);
  }
  assert.deepEqual(
    declaredTargetNames(manifest, 'testTarget').sort(),
    ['AgentDeviceMacOSHelperTests', 'AgentDeviceMacOSInputTests'].sort(),
  );
});
