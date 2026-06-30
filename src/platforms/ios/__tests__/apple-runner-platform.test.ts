import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  resolveRunnerDestination,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
  resolveRunnerXctestrunHints,
} from '../../apple/core/apple-runner-platform.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';

function iosSim(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

test('resolveRunnerPlatformName prefers appleOs and maps iOS/iPadOS to the iOS profile', () => {
  assert.equal(resolveRunnerPlatformName(iosSim({ appleOs: 'ios' })), 'iOS');
  assert.equal(resolveRunnerPlatformName(iosSim({ name: 'iPad Pro', appleOs: 'ipados' })), 'iOS');
});

test('resolveRunnerPlatformName maps tvOS appleOs to the tvOS profile', () => {
  assert.equal(
    resolveRunnerPlatformName(iosSim({ name: 'Apple TV 4K', target: 'tv', appleOs: 'tvos' })),
    'tvOS',
  );
});

test('resolveRunnerPlatformName maps visionOS appleOs to the visionOS profile', () => {
  const vision = iosSim({
    id: 'vision-sim-1',
    name: 'Apple Vision Pro',
    appleOs: 'visionos',
  });
  assert.equal(resolveRunnerPlatformName(vision), 'visionOS');
  assert.equal(resolveRunnerDestination(vision), 'platform=visionOS Simulator,id=vision-sim-1');
  assert.equal(resolveRunnerSdkName('visionOS', 'simulator'), 'xrsimulator');
});

test('resolveRunnerPlatformName maps macOS appleOs to the macOS profile', () => {
  const mac: DeviceInfo = {
    platform: 'macos',
    id: 'host-macos-local',
    name: 'Studio Mac',
    kind: 'device',
    target: 'desktop',
    appleOs: 'macos',
    booted: true,
  };
  assert.equal(resolveRunnerPlatformName(mac), 'macOS');
});

test('resolveRunnerPlatformName falls back to target inference for legacy records', () => {
  // No appleOs: behavior must match the pre-discriminant target inference.
  assert.equal(resolveRunnerPlatformName(iosSim()), 'iOS');
  assert.equal(resolveRunnerPlatformName(iosSim({ target: 'tv' })), 'tvOS');
});

test('iPadOS produces a byte-identical runner profile and destination to legacy iPad records', () => {
  const legacyIpad = iosSim({ id: 'sim-ipad', name: 'iPad Pro', target: 'mobile' });
  const taggedIpad = iosSim({
    id: 'sim-ipad',
    name: 'iPad Pro',
    target: 'mobile',
    appleOs: 'ipados',
  });
  assert.equal(resolveRunnerPlatformName(taggedIpad), resolveRunnerPlatformName(legacyIpad));
  assert.equal(resolveRunnerDestination(taggedIpad), resolveRunnerDestination(legacyIpad));
  assert.equal(resolveRunnerDestination(taggedIpad), 'platform=iOS Simulator,id=sim-ipad');
});

test('existing platform xctestrun disallowed hints stay unchanged when visionOS is added', () => {
  assert.deepEqual(resolveRunnerXctestrunHints(iosSim()).disallowed, [
    'iphoneos',
    'appletvos',
    'appletvsimulator',
    'macos',
  ]);
  assert.deepEqual(
    resolveRunnerXctestrunHints(iosSim({ target: 'tv', appleOs: 'tvos' })).disallowed,
    ['appletvos', 'iphoneos', 'iphonesimulator', 'macos'],
  );
  assert.deepEqual(
    resolveRunnerXctestrunHints({
      platform: 'macos',
      id: 'host-macos-local',
      name: 'Studio Mac',
      kind: 'device',
      target: 'desktop',
      appleOs: 'macos',
      booted: true,
    }).disallowed,
    ['iphoneos', 'iphonesimulator', 'appletvos', 'appletvsimulator'],
  );
  assert.deepEqual(
    resolveRunnerXctestrunHints(
      iosSim({ id: 'vision-sim-1', name: 'Apple Vision Pro', appleOs: 'visionos' }),
    ).disallowed,
    ['xros', 'iphoneos', 'iphonesimulator', 'appletvos', 'appletvsimulator', 'macos'],
  );
});
