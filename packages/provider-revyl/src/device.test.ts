import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { revylLease } from './revyl-backend.fixtures.ts';
import {
  buildRevylDevice,
  isSupportedRevylRuntimeDevice,
  parseRevylDeviceId,
  platformForRevylLeaseBackend,
} from './device.ts';

test('only the two instance backends name a Revyl platform', () => {
  assert.equal(platformForRevylLeaseBackend('ios-instance'), 'ios');
  assert.equal(platformForRevylLeaseBackend('android-instance'), 'android');
  assert.equal(platformForRevylLeaseBackend('ios-simulator'), undefined);
  assert.equal(platformForRevylLeaseBackend('browserstack-session'), undefined);
});

test('a rented device carries the identity and shape its platform implies', () => {
  assert.deepEqual(buildRevylDevice('ios', revylLease('ios'), 'run-1'), {
    platform: 'apple',
    appleOs: 'ios',
    id: 'revyl:ios:lease-1',
    name: 'Revyl ios run-1',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  });
  assert.deepEqual(buildRevylDevice('android', revylLease('android', 'lease-2'), 'run-2'), {
    platform: 'android',
    id: 'revyl:android:lease-2',
    name: 'Revyl android run-2',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  });
});

test('the display name keeps the run id whole', () => {
  // The name is the only handle an operator sees in `devices`, and it is what they paste into Revyl's
  // console to find the device. Two run ids that agree on their first eight characters would otherwise
  // name two different devices with one string.
  const name = buildRevylDevice(
    'ios',
    revylLease('ios'),
    'f3a9c1d2-8b40-4e7f-9c11-2a5d7e9b0c14',
  ).name;
  assert.equal(name, 'Revyl ios f3a9c1d2-8b40-4e7f-9c11-2a5d7e9b0c14');
});

test('a device id is read back only in the exact shape this module writes', () => {
  assert.deepEqual(parseRevylDeviceId('revyl:ios:lease-1'), {
    platform: 'ios',
    leaseId: 'lease-1',
  });
  assert.deepEqual(parseRevylDeviceId('revyl:android:lease-9'), {
    platform: 'android',
    leaseId: 'lease-9',
  });
  for (const value of [
    'browserstack:ios:lease-1',
    'revyl:tv:lease-1',
    'revyl:ios:',
    // A lease id that itself carries a separator would otherwise be read as one lease for the tail
    // and address the wrong session.
    'revyl:ios:lease:1',
    'revyl:ios',
    'revyl::lease-1',
    '',
  ]) {
    assert.equal(parseRevylDeviceId(value), undefined, value);
  }
});

test('only a device this module could have built is one it may act on', () => {
  const ios: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'revyl:ios:lease-1',
    name: 'Revyl ios run-1',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  assert.equal(isSupportedRevylRuntimeDevice(ios), true);
  assert.equal(
    isSupportedRevylRuntimeDevice(buildRevylDevice('android', revylLease('android'), 'r')),
    true,
  );

  for (const [name, device] of [
    ['another provider id', { ...ios, id: 'other:ios:lease-1' }],
    ['a desktop target', { ...ios, target: 'desktop' }],
    ['an iOS id on an Android shape', { ...ios, kind: 'emulator' }],
    [
      'an Android id on an iOS shape',
      { ...ios, platform: 'android', appleOs: undefined, kind: 'emulator' },
    ],
    ['a physical iOS backend', { ...ios, iosPhysicalDeviceBackend: 'coredevice' }],
  ] as const) {
    assert.equal(isSupportedRevylRuntimeDevice(device as DeviceInfo), false, name);
  }
});
