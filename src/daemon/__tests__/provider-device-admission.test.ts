import { afterEach, beforeEach, expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  installProviderDeviceAdmission,
  isActiveProviderDevice,
  providerDeviceAdmission,
} from '../provider-device-admission.ts';

const providerDevice = { id: 'provider-1', name: 'Cloud iPhone' } as unknown as DeviceInfo;
const localDevice = { id: 'local-1', name: 'iPhone 16' } as unknown as DeviceInfo;

let previous = providerDeviceAdmission();

beforeEach(() => {
  previous = providerDeviceAdmission();
});

afterEach(() => {
  installProviderDeviceAdmission(previous);
});

test('an un-composed process treats every device as local', () => {
  installProviderDeviceAdmission({ isActive: () => false });
  expect(isActiveProviderDevice(providerDevice)).toBe(false);
  expect(isActiveProviderDevice(localDevice)).toBe(false);
});

test('the installed admission is what the daemon decides on', () => {
  installProviderDeviceAdmission({ isActive: (device) => device.id === 'provider-1' });
  expect(isActiveProviderDevice(providerDevice)).toBe(true);
  expect(isActiveProviderDevice(localDevice)).toBe(false);
});

test('the fact is read per call, so a request-scoped scope stays live', () => {
  let owned = false;
  installProviderDeviceAdmission({ isActive: () => owned });
  expect(isActiveProviderDevice(providerDevice)).toBe(false);
  owned = true;
  expect(isActiveProviderDevice(providerDevice)).toBe(true);
});
