import {
  INTERNAL_COMMANDS,
  listMcpExposedCommandNames,
  PUBLIC_COMMANDS,
} from '../../command-catalog.ts';
import type { CommandCapability } from '../capabilities.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import { type CommandDescriptor, defineCommandDescriptor } from './types.ts';

// ---------------------------------------------------------------------------
// Daemon request-policy trait bundles — copied VERBATIM from
// src/daemon/daemon-command-registry.ts (DAEMON_COMMAND_DESCRIPTORS).
// ---------------------------------------------------------------------------

const ADMISSION_AND_LOCK_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
} as const;

const REQUEST_EXECUTION_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
  selectorValidationExempt: true,
} as const;

const allowAnyDeviceSessionless = (): boolean => true;

const isRecordingStartRequest = (req: DaemonRequest): boolean =>
  (req.positionals?.[0] ?? '').toLowerCase() === 'start';

const isShardedTestRequest = (req: DaemonRequest): boolean =>
  req.command === PUBLIC_COMMANDS.test &&
  (typeof req.flags?.shardAll === 'number' || typeof req.flags?.shardSplit === 'number');

// ---------------------------------------------------------------------------
// Capability predicates / matrices — copied VERBATIM from
// src/core/capabilities.ts (BASE_COMMAND_CAPABILITY_MATRIX).
// ---------------------------------------------------------------------------

const isNotMacOs = (device: DeviceInfo): boolean => device.platform !== 'macos';
const isMacOsOrAppleSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'macos' || device.kind === 'simulator';
const isIosMobileSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'ios' && device.kind === 'simulator' && device.target !== 'tv';
const supportsSynthesisGesture = (device: DeviceInfo): boolean =>
  device.platform === 'android' || isIosMobileSimulator(device);
const supportsAndroidOrIosNonTv = (device: DeviceInfo): boolean =>
  device.platform === 'android' || (device.platform === 'ios' && device.target !== 'tv');

const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  if (device.platform === 'macos')
    return 'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.target === 'tv')
    return 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

const APPLE_SIM_AND_DEVICE = { simulator: true, device: true };
const ANDROID_ALL = { emulator: true, device: true, unknown: true };
const LINUX_DEVICE = { device: true };
const LINUX_NONE = {};

const ALL_DEVICE_COMMAND_CAPABILITY = {
  apple: APPLE_SIM_AND_DEVICE,
  android: ANDROID_ALL,
  linux: LINUX_DEVICE,
} satisfies CommandCapability;
const APP_RUNTIME_CAPABILITY = ALL_DEVICE_COMMAND_CAPABILITY;
const APP_INVENTORY_CAPABILITY = {
  apple: APPLE_SIM_AND_DEVICE,
  android: ANDROID_ALL,
  linux: LINUX_NONE,
} satisfies CommandCapability;
const APP_INSTALL_CAPABILITY = {
  apple: APPLE_SIM_AND_DEVICE,
  android: ANDROID_ALL,
  linux: LINUX_NONE,
  supports: isNotMacOs,
} satisfies CommandCapability;

// ---------------------------------------------------------------------------
// The additive single source. Each entry carries the daemon route/traits +
// capability + batchable flag copied VERBATIM from today's hand tables.
//
// Entry order matches DAEMON_COMMAND_DESCRIPTORS exactly (the two trailing
// entries — `app-switcher` and `install-from-source` — have no daemon route and
// live only in the capability/batch hand tables).
// ---------------------------------------------------------------------------

const RAW_COMMAND_DESCRIPTORS: readonly Omit<CommandDescriptor, 'mcpExposed'>[] = [
  // -- lease (route: lease) --
  {
    name: INTERNAL_COMMANDS.leaseAllocate,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.leaseHeartbeat,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.leaseRelease,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    batchable: false,
  },

  // -- session (route: session) --
  {
    name: INTERNAL_COMMANDS.sessionList,
    daemon: { route: 'session', sessionKind: 'inventory', ...REQUEST_EXECUTION_EXEMPT },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.devices,
    daemon: {
      route: 'session',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.apps,
    daemon: {
      route: 'session',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      preferExplicitDeviceOverExistingSession: true,
    },
    capability: APP_INVENTORY_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.boot,
    daemon: { route: 'session', sessionKind: 'state' },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: isNotMacOs,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.shutdown,
    daemon: { route: 'session', sessionKind: 'state' },
    capability: {
      apple: { simulator: true },
      android: { emulator: true },
      linux: LINUX_NONE,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.appState,
    daemon: { route: 'session', sessionKind: 'state' },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.perf,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.logs,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.network,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.replay,
    daemon: {
      route: 'session',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.test,
    daemon: {
      route: 'session',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    batchable: true,
  },
  {
    name: INTERNAL_COMMANDS.runtime,
    daemon: { route: 'session' },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.clipboard,
    daemon: { route: 'session', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
      supports: (device) =>
        device.platform === 'android' ||
        device.platform === 'linux' ||
        device.platform === 'macos' ||
        device.kind === 'simulator',
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.keyboard,
    daemon: { route: 'session', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: supportsAndroidOrIosNonTv,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.install,
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.reinstall,
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    batchable: true,
  },
  {
    name: INTERNAL_COMMANDS.installSource,
    daemon: { route: 'session' },
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.releaseMaterializedPaths,
    daemon: { route: 'session', ...REQUEST_EXECUTION_EXEMPT },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.push,
    daemon: { route: 'session' },
    capability: {
      apple: { simulator: true },
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: isNotMacOs,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.triggerAppEvent,
    daemon: { route: 'session' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.open,
    daemon: { route: 'session', allowSessionlessDefaultDevice: allowAnyDeviceSessionless },
    capability: APP_RUNTIME_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.prepare,
    daemon: { route: 'session' },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.batch,
    daemon: { route: 'session' },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.close,
    daemon: { route: 'session', allowInvalidRecording: true },
    capability: APP_RUNTIME_CAPABILITY,
    batchable: true,
  },

  // -- snapshot (route: snapshot) --
  {
    name: PUBLIC_COMMANDS.snapshot,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.diff,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.wait,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.alert,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: (device) => device.platform === 'android' || isMacOsOrAppleSimulator(device),
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.settings,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: (device) =>
        device.platform === 'android' || device.platform === 'macos' || device.kind === 'simulator',
    },
    batchable: true,
  },

  // -- specialized routes --
  {
    name: PUBLIC_COMMANDS.reactNative,
    daemon: { route: 'reactNative', replayScopedAction: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.record,
    daemon: {
      route: 'recordTrace',
      replayScopedAction: true,
      allowInvalidRecording: true,
      allowSessionlessDefaultDevice: isRecordingStartRequest,
    },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.trace,
    daemon: { route: 'recordTrace' },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.find,
    daemon: { route: 'find', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },

  // -- interaction (route: interaction) --
  {
    name: PUBLIC_COMMANDS.click,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.fill,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.longPress,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.press,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.type,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.get,
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.is,
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },

  // -- generic (route: generic) --
  {
    name: PUBLIC_COMMANDS.back,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.gesture,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.home,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
      supports: isNotMacOs,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.rotate,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: supportsAndroidOrIosNonTv,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.scroll,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.swipe,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: 'pinch',
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: supportsSynthesisGesture,
      unsupportedHint: synthesisGestureUnsupportedHint,
    },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.focus,
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.screenshot,
    daemon: { route: 'generic', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.viewport,
    daemon: { route: 'generic', replayScopedAction: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: false,
  },
  {
    name: 'pan',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    batchable: false,
  },
  {
    name: 'fling',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    batchable: false,
  },
  {
    name: 'rotate-gesture',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: supportsSynthesisGesture,
      unsupportedHint: synthesisGestureUnsupportedHint,
    },
    batchable: false,
  },
  {
    name: 'transform-gesture',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: supportsSynthesisGesture,
      unsupportedHint: synthesisGestureUnsupportedHint,
    },
    batchable: false,
  },

  // -- capability/batch-only commands (no daemon route) --
  {
    name: PUBLIC_COMMANDS.appSwitcher,
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
      supports: isNotMacOs,
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.installFromSource,
    capability: APP_INSTALL_CAPABILITY,
    batchable: true,
  },
];

const MCP_EXPOSED_COMMAND_NAMES = new Set<string>(listMcpExposedCommandNames());

/**
 * The additive single source of truth (ADR-0008, Phase 1 step 1). Dormant: no
 * consumer reads it yet. Proven byte-equal to the live hand tables by
 * `__tests__/parity.test.ts`.
 */
export const commandDescriptors: readonly CommandDescriptor[] = RAW_COMMAND_DESCRIPTORS.map(
  (descriptor) =>
    defineCommandDescriptor({
      ...descriptor,
      mcpExposed: MCP_EXPOSED_COMMAND_NAMES.has(descriptor.name),
    }),
);
