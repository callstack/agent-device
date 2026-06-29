import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  isPlatform,
  matchesPlatformSelector,
  PLATFORMS,
  resolveApplePlatformName,
  resolveAppleSimulatorSetPathForSelector,
  resolveDevice,
} from '../../kernel/device.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';

test('matchesPlatformSelector resolves apple selector across Apple platforms', () => {
  assert.equal(matchesPlatformSelector('ios', 'apple'), true);
  assert.equal(matchesPlatformSelector('macos', 'apple'), true);
  assert.equal(matchesPlatformSelector('android', 'apple'), false);
});

test('isPlatform accepts exactly the canonical PLATFORMS tuple', () => {
  for (const platform of PLATFORMS) {
    assert.equal(isPlatform(platform), true);
  }
  // The `apple` selector is not a concrete leaf platform.
  assert.equal(isPlatform('apple'), false);
  assert.equal(isPlatform('windows'), false);
  assert.equal(isPlatform(undefined), false);
});

test('resolveApplePlatformName resolves tv and desktop targets', () => {
  assert.equal(resolveApplePlatformName('tv'), 'tvOS');
  assert.equal(resolveApplePlatformName('mobile'), 'iOS');
  assert.equal(resolveApplePlatformName('desktop'), 'macOS');
  assert.equal(resolveApplePlatformName('macos'), 'macOS');
  assert.equal(resolveApplePlatformName(undefined), 'iOS');
});

test('resolveApplePlatformName prefers the explicit appleOs over target inference', () => {
  // iOS and iPadOS both resolve to the single iOS runner profile.
  assert.equal(resolveApplePlatformName('mobile', 'ios'), 'iOS');
  assert.equal(resolveApplePlatformName('mobile', 'ipados'), 'iOS');
  assert.equal(resolveApplePlatformName('tv', 'tvos'), 'tvOS');
  assert.equal(resolveApplePlatformName('desktop', 'macos'), 'macOS');
});

test('resolveApplePlatformName appleOs wins even when it disagrees with the legacy target', () => {
  // A stored discriminant takes precedence; this guards the preference order.
  assert.equal(resolveApplePlatformName('mobile', 'tvos'), 'tvOS');
  assert.equal(resolveApplePlatformName('tv', 'ios'), 'iOS');
});

test('resolveApplePlatformName falls back to target inference for legacy records', () => {
  // Records without appleOs (undefined) must resolve byte-identically to before.
  assert.equal(resolveApplePlatformName('mobile', undefined), 'iOS');
  assert.equal(resolveApplePlatformName('tv', undefined), 'tvOS');
  assert.equal(resolveApplePlatformName('desktop', undefined), 'macOS');
  assert.equal(resolveApplePlatformName('macos', undefined), 'macOS');
});

test('resolveAppleSimulatorSetPathForSelector ignores simulator scoping for desktop selectors', () => {
  assert.equal(
    resolveAppleSimulatorSetPathForSelector({
      simulatorSetPath: '/tmp/scoped',
      platform: 'macos',
    }),
    undefined,
  );
  assert.equal(
    resolveAppleSimulatorSetPathForSelector({
      simulatorSetPath: '/tmp/scoped',
      platform: 'apple',
      target: 'desktop',
    }),
    undefined,
  );
  assert.equal(
    resolveAppleSimulatorSetPathForSelector({
      simulatorSetPath: '/tmp/scoped',
      platform: 'ios',
      target: 'mobile',
    }),
    '/tmp/scoped',
  );
});

test('resolveDevice throws DEVICE_NOT_FOUND with scoped set guidance when simulatorSetPath is set and no devices found', async () => {
  const setPath = '/path/to/sessions/abc/Simulators';
  const err = await resolveDevice([], { platform: 'ios' }, { simulatorSetPath: setPath }).catch(
    (e) => e,
  );
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
  assert.match(err.message, /scoped simulator set/);
  assert.equal(err.details?.simulatorSetPath, setPath);
  assert.ok(typeof err.details?.hint === 'string');
  assert.match(err.details.hint as string, /simctl --set/);
  assert.match(err.details.hint as string, /create/);
});

test('resolveDevice throws generic DEVICE_NOT_FOUND when no simulatorSetPath and no devices found', async () => {
  const err = await resolveDevice([], { platform: 'ios' }).catch((e) => e);
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
  assert.equal(err.message, 'No devices found');
  assert.equal(err.details?.simulatorSetPath, undefined);
});

test('resolveDevice does not apply scoped set guidance for non-iOS platform with simulatorSetPath', async () => {
  const setPath = '/path/to/sessions/abc/Simulators';
  const err = await resolveDevice([], { platform: 'android' }, { simulatorSetPath: setPath }).catch(
    (e) => e,
  );
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
  assert.equal(err.message, 'No devices found');
  assert.equal(err.details?.simulatorSetPath, undefined);
});

test('resolveDevice applies scoped set guidance when no platform selector specified and simulatorSetPath is set', async () => {
  const setPath = '/path/to/sessions/abc/Simulators';
  const err = await resolveDevice([], {}, { simulatorSetPath: setPath }).catch((e) => e);
  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
  assert.match(err.message, /scoped simulator set/);
  assert.equal(err.details?.simulatorSetPath, setPath);
});

test('resolveDevice prefers simulator over physical device when no explicit device selector', async () => {
  const physical: DeviceInfo = {
    platform: 'ios',
    id: 'phys-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  };
  const simulator: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: false,
  };
  const result = await resolveDevice([physical, simulator], { platform: 'ios' });
  assert.equal(result.id, 'sim-1');
  assert.equal(result.kind, 'simulator');
});

test('resolveDevice prefers booted simulator over physical device', async () => {
  const physical: DeviceInfo = {
    platform: 'ios',
    id: 'phys-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  };
  const sim1: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  };
  const sim2: DeviceInfo = {
    platform: 'ios',
    id: 'sim-2',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: false,
  };
  const result = await resolveDevice([physical, sim1, sim2], { platform: 'ios' });
  assert.equal(result.id, 'sim-1');
});

test('resolveDevice returns physical device when explicitly selected by deviceName', async () => {
  const physical: DeviceInfo = {
    platform: 'ios',
    id: 'phys-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  };
  const simulator: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  };
  const result = await resolveDevice([physical, simulator], {
    platform: 'ios',
    deviceName: 'My iPhone',
  });
  assert.equal(result.id, 'phys-1');
});
