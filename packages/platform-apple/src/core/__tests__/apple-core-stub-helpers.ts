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

// iPad carries the explicit `appleOs` discriminant discovery stores for it, while the iPhone above
// leaves it to inference, so a leaf rule is exercised on both readings.
export const IPADOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ipados',
  id: 'ipad-sim-1',
  name: 'iPad Pro 11-inch',
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

export const VISIONOS_TEST_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'visionos',
  id: 'visionos-sim-1',
  name: 'Apple Vision Pro',
  kind: 'simulator',
  booted: true,
};
