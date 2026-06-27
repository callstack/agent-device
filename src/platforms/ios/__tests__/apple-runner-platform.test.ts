import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveRunnerDestination, resolveRunnerPlatformName } from '../apple-runner-platform.ts';
import type { DeviceInfo } from '../../../utils/device.ts';

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
