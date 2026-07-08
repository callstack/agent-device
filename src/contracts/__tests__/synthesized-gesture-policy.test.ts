import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const RUNNER_SOURCES_DIR = path.join(
  PROJECT_ROOT,
  'apple-runner',
  'AgentDeviceRunner',
  'AgentDeviceRunnerUITests',
);
const MANIFEST_PATH = path.join(
  PROJECT_ROOT,
  'contracts',
  'fixtures',
  'synthesized-gesture-policy.json',
);

const POLICY_KINDS = new Set([
  'coordinateTap',
  'scroll',
  'synthesizedDrag',
  'sequenceSynthesizedTap',
  'sequenceSynthesizedDrag',
]);
const KEYBOARD_POLICIES = new Set(['never', 'whenAccessibilityHealthy']);
const FALLBACK_POLICIES = new Set([
  'privateSynthesisRequired',
  'xctestCoordinateWhenAccessibilityHealthy',
  'xctestCoordinateAllowed',
]);

type GesturePolicyDimension = {
  via: string;
  policy: string;
};

type GesturePolicyPath = {
  pathId: string;
  commands: string[];
  policyKind: string;
  keyboardPolicy: string;
  fallbackPolicy: string;
  activationPreflightPolicy?: string;
};

type GesturePolicyManifest = {
  dimensions: Record<
    'commandPolicyMapping' | 'axFreeSynthesis' | 'frameSourcePolicy' | 'activationPreflightPolicy',
    GesturePolicyDimension
  >;
  paths: GesturePolicyPath[];
};

function readManifest(): GesturePolicyManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as GesturePolicyManifest;
}

function pathById(manifest: GesturePolicyManifest, pathId: string): GesturePolicyPath {
  const entry = manifest.paths.find((path) => path.pathId === pathId);
  assert.ok(entry, `missing synthesized gesture policy path ${pathId}`);
  return entry;
}

test('synthesized gesture policy manifest has complete unique paths', () => {
  const manifest = readManifest();
  assert.deepEqual(manifest.paths.map((entry) => entry.pathId).sort(), [
    'ios-drag-synthesized',
    'ios-scroll-default',
    'ios-sequence-synthesized-drag',
    'ios-sequence-synthesized-tap',
    'ios-tap-synthesized-coordinate',
  ]);
  assert.equal(new Set(manifest.paths.map((entry) => entry.pathId)).size, manifest.paths.length);

  for (const entry of manifest.paths) {
    assert.ok(entry.commands.length > 0, `${entry.pathId}: commands must be non-empty`);
    assert.ok(POLICY_KINDS.has(entry.policyKind), `${entry.pathId}: unknown policy kind`);
    assert.ok(
      KEYBOARD_POLICIES.has(entry.keyboardPolicy),
      `${entry.pathId}: unknown keyboard policy`,
    );
    assert.ok(
      FALLBACK_POLICIES.has(entry.fallbackPolicy),
      `${entry.pathId}: unknown fallback policy`,
    );
  }
});

test('manifest dimensions reference real runner symbols', () => {
  const manifest = readManifest();
  assert.deepEqual(Object.keys(manifest.dimensions).sort(), [
    'activationPreflightPolicy',
    'axFreeSynthesis',
    'commandPolicyMapping',
    'frameSourcePolicy',
  ]);
  for (const [dimension, entry] of Object.entries(manifest.dimensions)) {
    assert.ok(entry.policy.trim().length > 0, `${dimension}: policy must be non-empty`);
    const [fileName, symbol] = entry.via.split('#');
    assert.ok(
      fileName && symbol,
      `${dimension}: via must be "<file>#<symbol>", got "${entry.via}"`,
    );
    const absolute = path.join(RUNNER_SOURCES_DIR, fileName);
    assert.ok(fs.existsSync(absolute), `${dimension}: runner source not found`);
    assert.ok(
      fs.readFileSync(absolute, 'utf8').includes(symbol),
      `${dimension}: "${symbol}" not found in ${fileName}`,
    );
  }
});

test('default iOS scroll declares no XCTest coordinate fallback', () => {
  const scroll = pathById(readManifest(), 'ios-scroll-default');

  assert.equal(scroll.policyKind, 'scroll');
  assert.equal(scroll.fallbackPolicy, 'privateSynthesisRequired');
});

test('coordinate synthesized iOS tap is the preflight escape hatch', () => {
  const tap = pathById(readManifest(), 'ios-tap-synthesized-coordinate');

  assert.equal(tap.fallbackPolicy, 'xctestCoordinateAllowed');
  assert.match(tap.activationPreflightPolicy ?? '', /may skip activation preflight/);
});

test('synthesized drag and sequence drag share fallback policy', () => {
  const manifest = readManifest();

  assert.equal(
    pathById(manifest, 'ios-drag-synthesized').fallbackPolicy,
    pathById(manifest, 'ios-sequence-synthesized-drag').fallbackPolicy,
  );
});
