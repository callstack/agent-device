import type { DeviceInfo } from '@agent-device/kernel/device';

// Apple-family device fixtures for runner tests; the package owns its own
// test data rather than reaching into root test-utils.

export const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  appleOs: 'ios',
  booted: true,
};

export const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone',
  kind: 'device',
  appleOs: 'ios',
  booted: true,
};

export const MACOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'host-macos-local',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  appleOs: 'macos',
  booted: true,
};

export const TVOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
  appleOs: 'tvos',
};
