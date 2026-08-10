import { describe, expect, test } from 'vitest';
import {
  deviceIdentity,
  deviceIdentityKey,
  deviceShape,
  sameDeviceIdentity,
  sameDeviceShape,
  type DeviceInfo,
} from './device.ts';

const DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'device-1',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  iosPhysicalDeviceBackend: 'coredevice',
  booted: true,
  simulatorSetPath: '/tmp/simulators',
};

describe('canonical device identity', () => {
  test('projects every ownership-qualified identity field', () => {
    expect(deviceIdentity(DEVICE)).toEqual({
      id: 'device-1',
      family: 'apple',
      appleOs: 'ios',
      kind: 'device',
      target: 'mobile',
      iosPhysicalDeviceBackend: 'coredevice',
    });
    expect(deviceShape(DEVICE)).toEqual({
      family: 'apple',
      appleOs: 'ios',
      kind: 'device',
      target: 'mobile',
      iosPhysicalDeviceBackend: 'coredevice',
    });
  });

  test.each([
    ['family', { ...DEVICE, platform: 'android' as const }],
    ['apple OS', { ...DEVICE, appleOs: 'ipados' as const }],
    ['id', { ...DEVICE, id: 'device-2' }],
    ['kind', { ...DEVICE, kind: 'simulator' as const }],
    ['target', { ...DEVICE, target: 'tv' as const }],
    ['physical backend', { ...DEVICE, iosPhysicalDeviceBackend: 'xctest' as const }],
  ])('treats %s as identity-bearing', (_field, changed) => {
    const canonical = deviceIdentity(DEVICE);
    const other = deviceIdentity(changed);
    expect(sameDeviceIdentity(canonical, other)).toBe(false);
    expect(deviceIdentityKey(canonical)).not.toBe(deviceIdentityKey(other));
  });

  test('excludes presentation and observation fields', () => {
    const changed: DeviceInfo = {
      ...DEVICE,
      name: 'Renamed iPhone',
      booted: false,
      simulatorSetPath: '/tmp/another-set',
    };
    expect(sameDeviceIdentity(deviceIdentity(DEVICE), deviceIdentity(changed))).toBe(true);
    expect(sameDeviceShape(deviceShape(DEVICE), deviceShape(changed))).toBe(true);
  });
});
