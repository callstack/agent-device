import type { DeviceInfo } from '@agent-device/kernel/device';

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
