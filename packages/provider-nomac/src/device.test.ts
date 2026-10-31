import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildNomacDevice,
  isSupportedNomacDevice,
  nomacPhoneDevice,
  parseNomacDeviceId,
} from './device.ts';

const lease = {
  leaseId: 'lease-1',
  tenantId: 't',
  runId: 'r',
  backend: 'ios-instance',
  leaseProvider: 'nomac',
  createdAt: 0,
  heartbeatAt: 0,
  expiresAt: 0,
} as const;

test('the phone a profile asks for: iPhone by default or an iPad, on iOS 27 only; anything else refused', () => {
  expect(nomacPhoneDevice(undefined)).toBe('iphone');
  expect(nomacPhoneDevice({ device: 'iPad' })).toBe('ipad');
  expect(nomacPhoneDevice({ device: 'iPad Pro 11-inch (M5)' })).toBe('ipad');
  expect(nomacPhoneDevice({ device: 'iPhone 17 Pro', providerOsVersion: '27' })).toBe('iphone');
  expect(nomacPhoneDevice({ device: 'ipad', providerOsVersion: '27.0' })).toBe('ipad');
  expect(() => nomacPhoneDevice({ providerOsVersion: '26' })).toThrow(/iOS 27 only/);
  for (const flags of [
    { device: 'Apple Watch' },
    { device: 'iPhone 12' },
    { providerOsVersion: '18' },
    { providerOsVersion: '28' },
    { device: 'ipad', providerOsVersion: '26' },
  ]) {
    expect(() => nomacPhoneDevice(flags)).toThrow(AppError);
  }
});

test('a NoMac device is an iOS simulator with an id it can read back to its lease', () => {
  const device = buildNomacDevice(lease, 'ses_0123456789abcdef', 'ipad');
  expect(device).toMatchObject({
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    target: 'mobile',
    id: 'nomac:ios:lease-1',
    model: 'iPad Pro 11-inch (M5)',
    booted: true,
  });
  expect(device.name).toBe('NoMac iPad Pro 11-inch (M5) 01234567');
  expect(parseNomacDeviceId(device.id)).toEqual({ leaseId: 'lease-1' });
  expect(isSupportedNomacDevice(device)).toBe(true);
  expect(parseNomacDeviceId('limrun:ios:lease-1')).toBeUndefined();
  expect(isSupportedNomacDevice({ ...device, kind: 'device' })).toBe(false);
});
