import {
  INTERNAL_COMMANDS,
  listMcpExposedCommandNames,
  PUBLIC_COMMANDS,
} from '../../command-catalog.ts';
import type { CommandCapability } from '../capabilities.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import { resolveWaitBudgetMs } from '../wait-positionals.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  PREPARE_REQUEST_TIMEOUT_MS,
} from './timeout-policy.ts';
import type { CommandDescriptor, CommandTimeoutPolicy } from './types.ts';

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
// Capability matrices — platform/kind buckets, copied VERBATIM from
// src/core/capabilities.ts (BASE_COMMAND_CAPABILITY_MATRIX).
//
// The per-command `supports()` / `unsupportedHint()` device closures that used to
// live here were RELOCATED VERBATIM onto the owning PlatformPlugin's
// `capability.supportsByDefault` / `unsupportedHintByDefault` in Phase 3 step b.2
// (the Apple family's closures live on the Apple plugin, src/platforms/apple/plugin.ts;
// android/linux/web plugins are wired in src/core/interactors/register-builtins.ts). The
// capability facet now carries platform/kind buckets only; admission reads the closure
// off the plugin.
// ---------------------------------------------------------------------------

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
} satisfies CommandCapability;

// ---------------------------------------------------------------------------
// Timeout policies (ADR-0011) — the request-envelope budget source and the
// on-timeout daemon policy, derived VERBATIM from the two deleted client hand
// lists (`isExplicitTimeoutCommand` in daemon-client.ts and
// `DAEMON_PRESERVING_TIMEOUT_COMMANDS` in daemon-client-timeout.ts) plus the
// per-command envelope branches of `resolveDaemonRequestTimeoutMs`.
// ---------------------------------------------------------------------------

// Read-only capture commands that can block in platform accessibility bridges
// while the app is crashed or never idle share snapshot's failure mode. Keep the
// daemon/session alive on their timeouts so callers can still collect
// screenshot/perf/log evidence and close the session after the runner abort
// path has been triggered — resetting the daemon here turned one timed-out wait
// into a lost session for every session the daemon owned.
const PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};

// Installs run long device subprocesses; their envelope stays above the longest
// platform install subprocess timeout (see INSTALL_REQUEST_TIMEOUT_MS).
const INSTALL_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  envelopeMs: INSTALL_REQUEST_TIMEOUT_MS,
};

// ---------------------------------------------------------------------------
// The additive single source. Each entry carries the daemon route/traits +
// capability + batchable flag copied VERBATIM from today's hand tables.
//
// Entry order matches DAEMON_COMMAND_DESCRIPTORS exactly (the two trailing
// entries — `app-switcher` and `install-from-source` — have no daemon route and
// live only in the capability/batch hand tables).
// ---------------------------------------------------------------------------

const RAW_COMMAND_DESCRIPTORS = [
  // -- lease (route: lease) --
  {
    name: INTERNAL_COMMANDS.leaseAllocate,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.leaseHeartbeat,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.leaseRelease,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.artifacts,
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },

  // -- session (route: session) --
  {
    name: INTERNAL_COMMANDS.sessionList,
    daemon: { route: 'session', sessionKind: 'inventory', ...REQUEST_EXECUTION_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
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
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.doctor,
    daemon: {
      route: 'session',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      allowSessionlessDefaultDevice: allowAnyDeviceSessionless,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
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
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.boot,
    daemon: { route: 'session', sessionKind: 'state' },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
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
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.appState,
    daemon: { route: 'session', sessionKind: 'state' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.perf,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.logs,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.network,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.audio,
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: { emulator: true },
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.replay,
    daemon: {
      route: 'session',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    // Replay durations are script-dependent; --timeout bounds the envelope.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.test,
    daemon: {
      route: 'session',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    // Test runs stream per-scenario progress and are budgeted downstream; no
    // client envelope at all.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, envelopeMs: 'unbounded' },
    batchable: true,
  },
  {
    name: INTERNAL_COMMANDS.runtime,
    daemon: { route: 'session' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.clipboard,
    daemon: { route: 'session', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.keyboard,
    daemon: { route: 'session', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.install,
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.reinstall,
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: INTERNAL_COMMANDS.installSource,
    daemon: { route: 'session' },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: INTERNAL_COMMANDS.releaseMaterializedPaths,
    daemon: { route: 'session', ...REQUEST_EXECUTION_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.push,
    daemon: { route: 'session' },
    capability: {
      apple: { simulator: true },
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.triggerAppEvent,
    daemon: { route: 'session' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.open,
    daemon: { route: 'session', allowSessionlessDefaultDevice: allowAnyDeviceSessionless },
    capability: APP_RUNTIME_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.prepare,
    daemon: { route: 'session' },
    // Runner warm-up builds are the longest fixed envelope; --timeout overrides.
    timeoutPolicy: {
      budget: { source: 'flag' },
      envelopeMs: PREPARE_REQUEST_TIMEOUT_MS,
      onTimeout: 'reset-daemon',
    },
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.batch,
    daemon: { route: 'session' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.close,
    daemon: { route: 'session', allowInvalidRecording: true },
    capability: APP_RUNTIME_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- snapshot (route: snapshot) --
  {
    name: PUBLIC_COMMANDS.snapshot,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    // First Apple snapshot on a device can sit behind runner startup; --timeout
    // widens the envelope, and a timeout must not tear down the daemon.
    timeoutPolicy: { ...PRESERVE_DAEMON_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.diff,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.wait,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    // The wait budget travels as a positional, not a flag; parse it the same
    // way the daemon will so the request envelope extends past it (#1075).
    timeoutPolicy: {
      ...PRESERVE_DAEMON_TIMEOUT_POLICY,
      budget: { source: 'positional-parser', parser: resolveWaitBudgetMs },
    },
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.alert,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.settings,
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- specialized routes --
  {
    name: PUBLIC_COMMANDS.reactNative,
    daemon: { route: 'reactNative', replayScopedAction: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
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
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.trace,
    daemon: { route: 'recordTrace' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.find,
    daemon: { route: 'find', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: PRESERVE_DAEMON_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- interaction (route: interaction) --
  {
    name: PUBLIC_COMMANDS.click,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.fill,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.longPress,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.press,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.type,
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.get,
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.is,
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- generic (route: generic) --
  {
    name: PUBLIC_COMMANDS.back,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.gesture,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.home,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.rotate,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.scroll,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.swipe,
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'pinch',
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: PUBLIC_COMMANDS.focus,
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.screenshot,
    daemon: { route: 'generic', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.viewport,
    daemon: { route: 'generic', replayScopedAction: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'pan',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'fling',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'rotate-gesture',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'transform-gesture',
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },

  // -- capability/batch-only commands (no daemon route) --
  {
    name: PUBLIC_COMMANDS.appSwitcher,
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: PUBLIC_COMMANDS.installFromSource,
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
] as const satisfies readonly Omit<CommandDescriptor, 'mcpExposed'>[];

const MCP_EXPOSED_COMMAND_NAMES = new Set<string>(listMcpExposedCommandNames());

/**
 * The additive single source of truth (ADR-0008, Phase 1 step 1). Proven
 * byte-equal to the live hand tables by `__tests__/parity.test.ts`.
 *
 * The `as const` on {@link RAW_COMMAND_DESCRIPTORS} flows through this `.map`,
 * so each entry keeps its literal `name`. That is what makes the {@link Command}
 * union below a precise set of command-name literals rather than `string`.
 */
export const commandDescriptors = RAW_COMMAND_DESCRIPTORS.map((descriptor) => ({
  ...descriptor,
  mcpExposed: MCP_EXPOSED_COMMAND_NAMES.has(descriptor.name),
})) satisfies readonly CommandDescriptor[];

/** The literal union of every registered command name. */
export type Command = (typeof commandDescriptors)[number]['name'];

const TIMEOUT_POLICY_BY_COMMAND: ReadonlyMap<string, CommandTimeoutPolicy> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor.timeoutPolicy]),
);

/**
 * The declared timeout policy for a command (ADR-0011). Command names outside
 * the registry (internal probes, unknown commands) fall back to
 * {@link DEFAULT_TIMEOUT_POLICY} — standard envelope, reset-daemon — exactly as
 * the deleted hand lists treated unlisted commands.
 */
export function resolveCommandTimeoutPolicy(command: string | undefined): CommandTimeoutPolicy {
  if (command === undefined) return DEFAULT_TIMEOUT_POLICY;
  return TIMEOUT_POLICY_BY_COMMAND.get(command) ?? DEFAULT_TIMEOUT_POLICY;
}
