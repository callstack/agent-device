import type { DeviceInfo } from '../../kernel/device.ts';

export const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

export const IOS_SIMULATOR: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  booted: true,
};

export const IOS_DEVICE: DeviceInfo = {
  platform: 'ios',
  id: 'ios-device-1',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

export const MACOS_DEVICE: DeviceInfo = {
  platform: 'macos',
  id: 'host-macos-local',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const LINUX_DEVICE: DeviceInfo = {
  platform: 'linux',
  id: 'local',
  name: 'Linux Desktop',
  kind: 'device',
  target: 'desktop',
};

export const WEB_DESKTOP_DEVICE: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const ANDROID_TV_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'and-tv-1',
  name: 'Android TV',
  kind: 'device',
  target: 'tv',
};

export const TVOS_SIMULATOR: DeviceInfo = {
  platform: 'ios',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
};

// iPadOS / visionOS carry the explicit `appleOs` discriminant discovery stores, so
// the per-AppleOS capability table's stored-`appleOs` read path is exercised (not just
// the target-based inference the iPhone/tvOS/macOS fixtures cover). Both are modeled as
// the touch iOS engine (`platform: 'ios'`, mobile target) and are capability-identical
// to iOS today.
export const IPADOS_SIMULATOR: DeviceInfo = {
  platform: 'ios',
  id: 'ipad-sim-1',
  name: 'iPad Pro 11-inch',
  kind: 'simulator',
  appleOs: 'ipados',
  booted: true,
};

export const VISIONOS_SIMULATOR: DeviceInfo = {
  platform: 'ios',
  id: 'vision-sim-1',
  name: 'Apple Vision Pro',
  kind: 'simulator',
  appleOs: 'visionos',
  booted: true,
};
