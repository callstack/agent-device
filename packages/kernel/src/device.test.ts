import assert from 'node:assert/strict';
import { test } from 'vitest';
import { devicesOverlap, hostAppDevice, hostDeviceIdOf, type DeviceInfo } from './device.ts';

const mac: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-mac',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
};

test('a host overlaps each of its app devices, and two of its app devices do not overlap', () => {
  const one = hostAppDevice(mac, 'com.example.One').id;
  const two = hostAppDevice(mac, 'com.example.two').id;
  assert.equal(one, hostAppDevice(mac, 'com.example.one').id);
  assert.equal(devicesOverlap(mac.id, one), true);
  assert.equal(devicesOverlap(two, mac.id), true);
  assert.equal(devicesOverlap(one, one), true);
  assert.equal(devicesOverlap(one, two), false);
  assert.equal(devicesOverlap('host-mac-2', one), false);
});

test('hostDeviceIdOf names the host of an app device and any other device itself', () => {
  assert.equal(hostDeviceIdOf(hostAppDevice(mac, 'com.example.one').id), mac.id);
  assert.equal(hostDeviceIdOf(mac.id), mac.id);
  assert.equal(hostDeviceIdOf('emulator-5554'), 'emulator-5554');
});
