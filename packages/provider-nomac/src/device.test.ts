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

test('the phone a profile asks for: iPhone by default, an iPad or a Pro Max, on iOS 27 only; anything else refused', () => {
  expect(nomacPhoneDevice(undefined)).toBe('iphone');
  expect(nomacPhoneDevice({ device: 'iphone-pro-max' })).toBe('iphone-pro-max');
  expect(nomacPhoneDevice({ device: 'iPhone 17 Pro Max' })).toBe('iphone-pro-max');
  expect(nomacPhoneDevice({ device: 'iPad' })).toBe('ipad');
  expect(nomacPhoneDevice({ device: 'iPad Pro 11-inch (M5)' })).toBe('ipad');
  expect(nomacPhoneDevice({ device: 'iPhone 17 Pro', providerOsVersion: '27' })).toBe('iphone');
  expect(nomacPhoneDevice({ device: 'ipad', providerOsVersion: '27.0' })).toBe('ipad');
  expect(() => nomacPhoneDevice({ providerOsVersion: '26' })).toThrow(/run iOS 27/);
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
  const device = buildNomacDevice(lease, 'ipad');
  expect(device).toMatchObject({
    platform: 'apple',
    appleOs: 'ios',
    kind: 'simulator',
    target: 'mobile',
    id: 'nomac:ios:lease-1',
    model: 'iPad Pro 11-inch (M5)',
    booted: true,
  });
  // The name `--device` selects it by: the model's, which connect saves as the profile's device.
  expect(device.name).toBe('iPad Pro 11-inch (M5)');
  expect(parseNomacDeviceId(device.id)).toEqual({ leaseId: 'lease-1' });
  expect(isSupportedNomacDevice(device)).toBe(true);
  expect(parseNomacDeviceId('limrun:ios:lease-1')).toBeUndefined();
  expect(isSupportedNomacDevice({ ...device, kind: 'device' })).toBe(false);
});
