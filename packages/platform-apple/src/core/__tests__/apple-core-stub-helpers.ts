import type { DeviceInfo } from '@agent-device/kernel/device';

export const IOS_TEST_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone Device',
  kind: 'device',
  booted: true,
};

export const IOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

export const MACOS_TEST_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const TVOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'tvos-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  booted: true,
};
