import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  normalizeDevice,
  normalizeDeviceSelection,
  normalizeOpenDevice,
  normalizeSession,
} from '../client/client-normalizers.ts';
import { PUBLIC_PLATFORMS } from '@agent-device/kernel/device';

test('normalizeOpenDevice accepts exactly the canonical leaf platforms', () => {
  for (const platform of PUBLIC_PLATFORMS) {
    const result = normalizeOpenDevice({
      platform,
      id: 'device-1',
      device: 'Device One',
    });
    assert.ok(result, `expected platform "${platform}" to be accepted`);
    assert.equal(result.platform, platform);
  }
  // Lock the membership so the derived check cannot silently widen/narrow.
  assert.deepEqual(
    [...PUBLIC_PLATFORMS],
    ['ios', 'macos', 'android', 'harmonyos', 'vega', 'linux', 'web'],
  );
});

test('normalizeDeviceSelection preserves structured resolver evidence and rejects malformed data', () => {
  assert.deepEqual(
    normalizeDeviceSelection({
      reason: 'single-app-installed-local',
      source: 'local',
      candidateCount: 1,
      bootOccurred: false,
    }),
    {
      reason: 'single-app-installed-local',
      source: 'local',
      candidateCount: 1,
      bootOccurred: false,
    },
  );
  assert.equal(
    normalizeDeviceSelection({
      reason: 'single-booted-local',
      source: 'local',
      candidateCount: -1,
      bootOccurred: false,
    }),
    undefined,
  );
});

test('normalizeOpenDevice rejects the apple selector and unknown platforms', () => {
  // `apple` is a selector, not a concrete device platform, so it must be rejected here.
  assert.equal(
    normalizeOpenDevice({ platform: 'apple', id: 'device-1', device: 'Device One' }),
    undefined,
  );
  assert.equal(
    normalizeOpenDevice({ platform: 'windows', id: 'device-1', device: 'Device One' }),
    undefined,
  );
  assert.equal(
    normalizeOpenDevice({ platform: undefined, id: 'device-1', device: 'Device One' }),
    undefined,
  );
});

test('normalizeDevice carries the additive appleOs discriminant when present', () => {
  const ipad = normalizeDevice({
    platform: 'ios',
    appleOs: 'ipados',
    id: 'ipad-sim-1',
    name: 'iPad Pro 11-inch',
    kind: 'simulator',
    booted: true,
  });
  assert.equal(ipad.appleOs, 'ipados');
  // `platform` stays the PUBLIC leaf; appleOs is additive, not a replacement.
  assert.equal(ipad.platform, 'ios');
});

test('normalizeDevice omits appleOs for non-Apple and invalid values', () => {
  const android = normalizeDevice({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
  });
  assert.equal('appleOs' in android, false);

  const bogus = normalizeDevice({
    platform: 'ios',
    appleOs: 'windowsphone',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
  });
  assert.equal('appleOs' in bogus, false);

  // Regression: a non-Apple platform carrying a VALID Apple OS value must still be
  // dropped — appleOs is Apple-only, gated on the platform, not merely on being a
  // valid AppleOS value.
  const androidWithStrayAppleOs = normalizeDevice({
    platform: 'android',
    appleOs: 'macos',
    id: 'emulator-5555',
    name: 'Pixel',
    kind: 'emulator',
  });
  assert.equal('appleOs' in androidWithStrayAppleOs, false);
});

test('normalizeSession carries the additive appleOs discriminant on the session device', () => {
  const session = normalizeSession({
    name: 'default',
    createdAt: 1,
    platform: 'ios',
    appleOs: 'tvos',
    id: 'tv-sim-1',
    device: 'Apple TV',
    target: 'tv',
  });
  assert.equal(session.device.appleOs, 'tvos');
  assert.equal(session.device.platform, 'ios');
});

test('normalizeOpenDevice preserves iOS identifier shaping', () => {
  const ios = normalizeOpenDevice({
    platform: 'ios',
    id: 'udid-1',
    device: 'iPhone',
    ios_simulator_device_set: '/tmp/set',
  });
  assert.deepEqual(ios?.ios, { udid: 'udid-1', simulatorSetPath: '/tmp/set' });
  assert.equal(ios?.android, undefined);
  assert.equal('android' in (ios ?? {}), false);
  assert.equal('vega' in (ios ?? {}), false);
});

test('normalizeOpenDevice preserves Android identifier shaping', () => {
  const android = normalizeOpenDevice({
    platform: 'android',
    id: 'serial-1',
    device: 'Pixel',
    serial: 'explicit-serial',
  });
  assert.deepEqual(android?.android, { serial: 'explicit-serial' });
  assert.equal(android?.ios, undefined);
  assert.equal(android?.identifiers.serial, 'explicit-serial');
  assert.equal('ios' in (android ?? {}), false);
  assert.equal('vega' in (android ?? {}), false);
});

test('normalizeOpenDevice preserves Vega identifier shaping', () => {
  const vega = normalizeOpenDevice({
    platform: 'vega',
    id: 'VirtualDevice',
    device: 'Vega Virtual Device',
    serial: 'explicit-vega-serial',
  });
  assert.deepEqual(vega?.vega, { serial: 'explicit-vega-serial' });
  assert.equal(vega?.ios, undefined);
  assert.equal(vega?.android, undefined);
  assert.equal(vega?.identifiers.serial, 'explicit-vega-serial');
  assert.equal('ios' in (vega ?? {}), false);
  assert.equal('android' in (vega ?? {}), false);
});
