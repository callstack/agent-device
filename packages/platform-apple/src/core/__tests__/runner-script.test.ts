import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isRunnerXcuitestScriptPlatform,
  resolveRunnerScriptDefaultDerivedPath,
  resolveRunnerScriptDevice,
} from '../runner-script.ts';

test('resolveRunnerScriptDevice reads the simulator kind from the destination platform token', () => {
  const udid = '5AF10197-87C1-4799-835E-3C6CBF9F3163';

  assert.equal(
    resolveRunnerScriptDevice('ios', `platform=iOS Simulator,id=${udid}`).kind,
    'simulator',
  );
  // xcodebuild matches the platform token case-insensitively, so a lowercase spelling still
  // builds the simulator SDK and must not be certified as a physical-device runner.
  assert.equal(
    resolveRunnerScriptDevice('ios', `platform=iOS simulator,id=${udid}`).kind,
    'simulator',
  );
  assert.equal(
    resolveRunnerScriptDevice('ios', 'generic/platform=iOS Simulator').kind,
    'simulator',
  );
  assert.equal(resolveRunnerScriptDevice('ios', 'generic/platform=iOS').kind, 'device');
  assert.equal(resolveRunnerScriptDevice('tvos', 'platform=tvOS Simulator,id=x').kind, 'simulator');
});

test('resolveRunnerScriptDevice records a macOS build as the host device', () => {
  assert.equal(resolveRunnerScriptDevice('macos', 'platform=macOS,arch=arm64').kind, 'device');
  assert.equal(resolveRunnerScriptDevice('macos', 'platform=macOS,arch=arm64').target, 'desktop');
});

test('resolveRunnerScriptDevice refuses a destination that leaves the SDK to the scheme', () => {
  assert.throws(
    () => resolveRunnerScriptDevice('ios', 'id=5AF10197-87C1-4799-835E-3C6CBF9F3163'),
    /must name its platform/,
  );
});

test('isRunnerXcuitestScriptPlatform accepts only the platforms the build script knows', () => {
  assert.equal(isRunnerXcuitestScriptPlatform('ios'), true);
  assert.equal(isRunnerXcuitestScriptPlatform('visionos'), true);
  assert.equal(isRunnerXcuitestScriptPlatform('watchos'), false);
  assert.equal(isRunnerXcuitestScriptPlatform('iOS'), false);
  assert.equal(isRunnerXcuitestScriptPlatform(''), false);
});

test('the script default derived path is the shared base for iOS and a subdirectory for the others', () => {
  const base = path.join('/home/tester', '.agent-device', 'apple-runner', 'derived');
  assert.equal(resolveRunnerScriptDefaultDerivedPath('ios', '/home/tester'), base);
  assert.equal(
    resolveRunnerScriptDefaultDerivedPath('macos', '/home/tester'),
    path.join(base, 'macos'),
  );
  assert.equal(
    resolveRunnerScriptDefaultDerivedPath('visionos', '/home/tester'),
    path.join(base, 'visionos'),
  );
});
