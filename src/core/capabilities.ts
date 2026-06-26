import type { DeviceInfo } from '../utils/device.ts';

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
const WEB_RUNTIME_COMMANDS = ['open', 'close'] as const;
const WEB_RECORDING_COMMANDS = ['record'] as const;
const WEB_QUERY_COMMANDS = [
  'find',
  'get',
  'is',
  'network',
  'screenshot',
  'snapshot',
  'wait',
] as const;
const WEB_INTERACTION_COMMANDS = ['click', 'fill', 'focus', 'press', 'scroll', 'type'] as const;
const WEB_SETTING_COMMANDS = ['viewport'] as const;
const WEB_SUPPORTED_COMMANDS = new Set<string>([
  ...WEB_RUNTIME_COMMANDS,
  ...WEB_RECORDING_COMMANDS,
  ...WEB_QUERY_COMMANDS,
  ...WEB_INTERACTION_COMMANDS,
  ...WEB_SETTING_COMMANDS,
]);
const ALL_DEVICE_COMMAND_CAPABILITY = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  linux: LINUX_DEVICE,
} as const satisfies CommandCapability;
const APP_RUNTIME_CAPABILITY = ALL_DEVICE_COMMAND_CAPABILITY;
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

const BASE_COMMAND_CAPABILITY_MATRIX: Record<string, CommandCapability> = {
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
  },
  fling: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  snapshot: ALL_DEVICE_COMMAND_CAPABILITY,
  diff: ALL_DEVICE_COMMAND_CAPABILITY,
  screenshot: ALL_DEVICE_COMMAND_CAPABILITY,
  wait: ALL_DEVICE_COMMAND_CAPABILITY,
  get: ALL_DEVICE_COMMAND_CAPABILITY,
  find: ALL_DEVICE_COMMAND_CAPABILITY,
  is: ALL_DEVICE_COMMAND_CAPABILITY,
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
  viewport: {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  'trigger-app-event': {
    apple: { simulator: true, device: true },
    android: { emulator: true, device: true, unknown: true },
    linux: LINUX_NONE,
  },
  type: ALL_DEVICE_COMMAND_CAPABILITY,
};

const COMMAND_CAPABILITY_MATRIX = addWebCommandCapabilities(BASE_COMMAND_CAPABILITY_MATRIX);

function addWebCommandCapabilities(
  matrix: Record<string, CommandCapability>,
): Record<string, CommandCapability> {
  const result: Record<string, CommandCapability> = {};
  for (const [command, capability] of Object.entries(matrix)) {
    result[command] = WEB_SUPPORTED_COMMANDS.has(command)
      ? { ...capability, web: WEB_DEVICE }
      : capability;
  }
  for (const command of WEB_SUPPORTED_COMMANDS) {
    if (!(command in matrix)) {
      throw new Error(`Web command "${command}" missing from capability matrix`);
    }
  }
  return result;
}

// Exhaustive platform -> capability-bucket selection. Switching over the full Platform
// union (instead of an if/else ladder that funnels every unmatched platform into
// `capability.web`) makes adding a new Platform a compile error here, so a future
// platform can no longer silently inherit web's capability matrix.
function selectCapabilityForPlatform(
  capability: CommandCapability,
  platform: DeviceInfo['platform'],
): KindMatrix | undefined {
  switch (platform) {
    case 'ios':
    case 'macos':
      return capability.apple;
    case 'android':
      return capability.android;
    case 'linux':
      return capability.linux;
    case 'web':
      return capability.web;
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}

export function isCommandSupportedOnDevice(command: string, device: DeviceInfo): boolean {
  const capability = COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  const byPlatform = selectCapabilityForPlatform(capability, device.platform);
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
