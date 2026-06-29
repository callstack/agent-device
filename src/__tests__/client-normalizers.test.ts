import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeOpenDevice } from '../client-normalizers.ts';
import { PLATFORMS } from '../kernel/device.ts';

test('normalizeOpenDevice accepts exactly the canonical leaf platforms', () => {
  for (const platform of PLATFORMS) {
    const result = normalizeOpenDevice({
      platform,
      id: 'device-1',
      device: 'Device One',
    });
    assert.ok(result, `expected platform "${platform}" to be accepted`);
    assert.equal(result.platform, platform);
  }
  // Lock the membership so the derived check cannot silently widen/narrow.
  assert.deepEqual([...PLATFORMS], ['ios', 'macos', 'android', 'linux', 'web']);
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

test('normalizeOpenDevice preserves per-platform identifier shaping', () => {
  const ios = normalizeOpenDevice({
    platform: 'ios',
    id: 'udid-1',
    device: 'iPhone',
    ios_simulator_device_set: '/tmp/set',
  });
  assert.deepEqual(ios?.ios, { udid: 'udid-1', simulatorSetPath: '/tmp/set' });
  assert.equal(ios?.android, undefined);

  const android = normalizeOpenDevice({
    platform: 'android',
    id: 'serial-1',
    device: 'Pixel',
    serial: 'explicit-serial',
  });
  assert.deepEqual(android?.android, { serial: 'explicit-serial' });
  assert.equal(android?.ios, undefined);
});
