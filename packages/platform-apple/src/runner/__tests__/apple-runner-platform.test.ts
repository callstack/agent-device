import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isRunnerXcuitestScriptPlatform,
  resolveRunnerDestination,
  resolveRunnerScriptDevice,
  resolveRunnerHandoffTarget,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
  resolveRunnerXctestrunHints,
} from '../apple-runner-platform.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

function iosSim(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
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
    platform: 'apple',
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
      platform: 'apple',
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

function iosDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    id: 'device-1',
    name: 'iPhone 17 Pro',
    kind: 'device',
    target: 'mobile',
    appleOs: 'ios',
    booted: true,
    ...overrides,
  };
}

test('handoff covers Apple simulators, including tvOS simulators as before #2681', () => {
  assert.deepEqual(resolveRunnerHandoffTarget(iosSim()), { handoff: true, lane: 'simulator' });
  assert.deepEqual(resolveRunnerHandoffTarget(iosSim({ target: 'tv', appleOs: 'tvos' })), {
    handoff: true,
    lane: 'simulator',
  });
});

test('handoff covers a physical iOS device reached through CoreDevice', () => {
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice()), {
    handoff: true,
    lane: 'physical_coredevice',
  });
  assert.deepEqual(
    resolveRunnerHandoffTarget(iosDevice({ iosPhysicalDeviceBackend: 'coredevice' })),
    { handoff: true, lane: 'physical_coredevice' },
  );
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice({ appleOs: 'ipados', name: 'iPad Pro' })), {
    handoff: true,
    lane: 'physical_coredevice',
  });
});

test('the macOS desktop host is refused although it is also kind device', () => {
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice({ appleOs: 'macos', target: 'desktop' })), {
    handoff: false,
    reason: 'macos_host',
  });
});

test('physical tvOS and visionOS runners are refused: kind device is not physical iOS', () => {
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice({ appleOs: 'tvos', target: 'tv' })), {
    handoff: false,
    reason: 'physical_non_ios_os',
  });
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice({ appleOs: 'visionos' })), {
    handoff: false,
    reason: 'physical_non_ios_os',
  });
});

test('the usbmux-only xctest backend is refused while coredevice is named explicitly', () => {
  assert.deepEqual(resolveRunnerHandoffTarget(iosDevice({ iosPhysicalDeviceBackend: 'xctest' })), {
    handoff: false,
    reason: 'xctest_backend',
  });
});

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

test('a non-Apple target is refused instead of defaulting into the physical lane', () => {
  assert.deepEqual(
    resolveRunnerHandoffTarget({
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel 8',
      kind: 'device',
      target: 'mobile',
    }),
    { handoff: false, reason: 'non_apple_target' },
  );
});
