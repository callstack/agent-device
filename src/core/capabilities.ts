import { isApplePlatform, type DeviceInfo } from '../utils/device.ts';

type KindMatrix = {
  simulator?: boolean;
  device?: boolean;
  emulator?: boolean;
  unknown?: boolean;
};

export type CommandCapability = {
  apple?: KindMatrix;
  android?: KindMatrix;
  linux?: KindMatrix;
  web?: KindMatrix;
  supports?: (device: DeviceInfo) => boolean;
  /** Optional actionable hint surfaced when this command is rejected at admission for `device`. */
  unsupportedHint?: (device: DeviceInfo) => string | undefined;
};

const isNotMacOs = (device: DeviceInfo): boolean => device.platform !== 'macos';
const isMacOsOrAppleSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'macos' || device.kind === 'simulator';
const isIosMobileSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'ios' && device.kind === 'simulator' && device.target !== 'tv';

// Two-finger gesture synthesis (RunnerSynthesizedGesture) is iOS-simulator-only (plus Android).
// When such a gesture is rejected at admission, explain where it IS available so an agent can
// redirect instead of getting a bare "not supported on this device".
const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  if (device.platform === 'macos')
    return 'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.target === 'tv')
    return 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

// Linux desktop supports these commands via xdotool/ydotool + AT-SPI2.
// Linux device kind is always 'device' (local desktop).
const LINUX_DEVICE: KindMatrix = { device: true };
const LINUX_NONE: KindMatrix = {};
const WEB_DEVICE: KindMatrix = { device: true };
const ALL_DEVICE_COMMAND_CAPABILITY = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  linux: LINUX_DEVICE,
} as const satisfies CommandCapability;
const WEB_COMMAND_CAPABILITY = {
  ...ALL_DEVICE_COMMAND_CAPABILITY,
  web: WEB_DEVICE,
} as const satisfies CommandCapability;
const APP_RUNTIME_CAPABILITY = WEB_COMMAND_CAPABILITY;
const APP_INVENTORY_CAPABILITY = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  linux: LINUX_NONE,
} as const satisfies CommandCapability;
const APP_INSTALL_CAPABILITY = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  linux: LINUX_NONE,
  supports: isNotMacOs,
} as const satisfies CommandCapability;

const COMMAND_CAPABILITY_MATRIX: Record<string, CommandCapability> = {
  // Apple simulator-only.
  alert: {
    // macOS desktop targets report kind=device, so this stays enabled here and the
    // supports() guard excludes iOS physical devices.
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) => device.platform === 'android' || isMacOsOrAppleSimulator(device),
  },
  pinch: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    // iOS-simulator-only (plus Android): pinch is driven by the two-finger XCTest synthesis
    // path (RunnerSynthesizedGesture), which is iOS-only. macOS has no multi-touch synthesis, so
    // it is excluded and fails fast at admission rather than round-tripping to an unsupported
    // runner. Matches rotate-gesture / transform-gesture.
    supports: (device) => device.platform === 'android' || isIosMobileSimulator(device),
    unsupportedHint: synthesisGestureUnsupportedHint,
  },
  'rotate-gesture': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) => device.platform === 'android' || isIosMobileSimulator(device),
    unsupportedHint: synthesisGestureUnsupportedHint,
  },
  'transform-gesture': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) => device.platform === 'android' || isIosMobileSimulator(device),
    unsupportedHint: synthesisGestureUnsupportedHint,
  },
  'app-switcher': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: isNotMacOs,
  },
  open: APP_RUNTIME_CAPABILITY,
  close: APP_RUNTIME_CAPABILITY,
  reinstall: APP_INSTALL_CAPABILITY,
  install: APP_INSTALL_CAPABILITY,
  'install-from-source': APP_INSTALL_CAPABILITY,
  apps: APP_INVENTORY_CAPABILITY,
  back: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
  },
  boot: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: isNotMacOs,
  },
  shutdown: {
    apple: { simulator: true },
    android: { emulator: true },
    linux: LINUX_NONE,
  },
  click: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    web: WEB_DEVICE,
  },
  clipboard: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    supports: (device) =>
      device.platform === 'android' ||
      device.platform === 'linux' ||
      device.platform === 'macos' ||
      device.kind === 'simulator',
  },
  keyboard: {
    // iOS only supports keyboard dismiss/enter; status/get remains Android-only.
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) =>
      device.platform === 'android' || (device.platform === 'ios' && device.target !== 'tv'),
  },
  fill: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    web: WEB_DEVICE,
  },
  fling: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  snapshot: WEB_COMMAND_CAPABILITY,
  diff: ALL_DEVICE_COMMAND_CAPABILITY,
  screenshot: WEB_COMMAND_CAPABILITY,
  wait: WEB_COMMAND_CAPABILITY,
  get: WEB_COMMAND_CAPABILITY,
  find: WEB_COMMAND_CAPABILITY,
  is: WEB_COMMAND_CAPABILITY,
  focus: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
  },
  home: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    supports: isNotMacOs,
  },
  logs: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  network: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  longpress: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
  },
  perf: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  pan: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
  },
  press: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    web: WEB_DEVICE,
  },
  push: {
    apple: { simulator: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: isNotMacOs,
  },
  record: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  'react-native': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  rotate: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) =>
      device.platform === 'android' || (device.platform === 'ios' && device.target !== 'tv'),
  },
  scroll: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
    web: WEB_DEVICE,
  },
  swipe: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_DEVICE,
  },
  settings: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
    supports: (device) =>
      device.platform === 'android' || device.platform === 'macos' || device.kind === 'simulator',
  },
  'trigger-app-event': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  type: WEB_COMMAND_CAPABILITY,
};

export function isCommandSupportedOnDevice(command: string, device: DeviceInfo): boolean {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  const byPlatform = isApplePlatform(device.platform)
    ? capability.apple
    : device.platform === 'android'
      ? capability.android
      : device.platform === 'linux'
        ? capability.linux
        : capability.web;
  if (!byPlatform) return false;
  if (capability.supports && !capability.supports(device)) return false;
  const kind = (device.kind ?? 'unknown') as keyof KindMatrix;
  return byPlatform[kind] === true;
}

export function unsupportedHintForDevice(command: string, device: DeviceInfo): string | undefined {
  return COMMAND_CAPABILITY_MATRIX[command]?.unsupportedHint?.(device);
}

export function listCapabilityCommands(): string[] {
  return Object.keys(COMMAND_CAPABILITY_MATRIX).sort();
}
