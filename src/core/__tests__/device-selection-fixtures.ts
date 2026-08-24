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
