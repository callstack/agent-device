import type { DeviceInfo } from '@agent-device/kernel/device';

export const STOPPED_ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'Pixel_9_Pro_XL',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  target: 'mobile',
  booted: false,
};

export const SECOND_BOOTED_ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Pixel 8',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

export const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

export const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
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
