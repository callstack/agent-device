import type { CommandCapability } from '../capabilities.ts';
import type { DaemonRequest } from '../../daemon/types.ts';
import { resolveWaitBudgetMs } from '../wait-positionals.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  PREPARE_REQUEST_TIMEOUT_MS,
} from './timeout-policy.ts';
import { resolvePostActionObservationSupport } from './post-action-observation.ts';
import type { PostActionObservationSupport } from './post-action-observation.ts';
import type {
  CommandCatalogGroup,
  CommandDescriptor,
  CommandResponseDataTransform,
  CommandTimeoutPolicy,
} from './types.ts';

type RawCommandDescriptor = Omit<CommandDescriptor, 'mcpExposed'> & {
  mcpExposed?: boolean;
};

type RawCommandCatalogGroup<T> = T extends { catalog: { group: infer Group } } ? Group : never;

type RawCommandCatalogKey<T> = T extends { catalog: { key: infer Key extends string } }
  ? Key
  : T extends { name: infer Name extends string }
    ? Name
    : never;

export type DescriptorCommandNameForCatalogGroup<Group extends CommandCatalogGroup> =
  Extract<(typeof commandDescriptors)[number], { name: string }> extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? RawCommandCatalogGroup<Descriptor> extends Group
        ? Name
        : never
      : never
    : never;

export type DescriptorCliCommandName =
  | DescriptorCommandNameForCatalogGroup<'public'>
  | DescriptorCommandNameForCatalogGroup<'local-cli'>;

export type DescriptorCatalogRecord<Group extends CommandCatalogGroup> = {
  readonly [Descriptor in Extract<
    (typeof commandDescriptors)[number],
    { name: string }
  > as RawCommandCatalogGroup<Descriptor> extends Group
    ? RawCommandCatalogKey<Descriptor>
    : never]: Descriptor['name'];
};

export type DescriptorDispatchCommandName =
  Extract<(typeof commandDescriptors)[number], { dispatch: object }> extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? Name
      : never
    : never;

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
  req.command === 'test' &&
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
// Timeout policies — descriptor-owned request-envelope budget source and
// on-timeout daemon policy (ADR 0008). This replaces the two deleted client
// hand lists (`isExplicitTimeoutCommand` in daemon-client.ts and
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

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

// Settle-capable interaction commands also resolve their target through the
// same platform accessibility capture as snapshot/find (#1105): a hung capture
// is their dominant timeout mode, so on top of the --settle flag-sourced
// widening envelope above, keep the daemon (and sessions) alive on timeout too.
const SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  // --settle (#1101) makes --timeout bound the SETTLE wait, not the whole
  // request. Widen the envelope by the settle budget so selector/action
  // overhead still has room before the post-action wait.
  budget: {
    source: 'flag',
    envelope: 'widen',
    defaultBudgetMs: DEFAULT_SETTLE_TIMEOUT_MS,
  },
  onTimeout: 'preserve-daemon',
};

const TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM = {
  fields: {
    count: { defaultValue: 1, omitDefault: true },
    intervalMs: { defaultValue: 0, omitDefault: true },
    holdMs: { defaultValue: 0, omitDefault: true },
    jitterPx: { defaultValue: 0, omitDefault: true },
    doubleTap: { defaultValue: false, omitDefault: true },
  },
} as const satisfies CommandResponseDataTransform;

const FILL_INTERACTION_RESPONSE_DATA_TRANSFORM = {
  fields: {
    delayMs: { defaultValue: 0 },
  },
} as const satisfies CommandResponseDataTransform;

function interactionTimeoutPolicy(command: string): CommandTimeoutPolicy {
  return resolvePostActionObservationSupport(command) !== undefined
    ? SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY
    : PRESERVE_DAEMON_TIMEOUT_POLICY;
}

function postActionObservation(command: string): PostActionObservationSupport {
  const support = resolvePostActionObservationSupport(command);
  if (support === undefined) {
    throw new Error(`Missing post-action observation descriptor support for ${command}`);
  }
  return support;
}

// ---------------------------------------------------------------------------
// The additive single source. Each entry carries the command identity facets
// plus whichever daemon, capability, batch, MCP, timeout, observation, and
// platform-dispatch traits that command owns. Public catalog identity and the
// non-public dispatch aliases now live here too; leaf views derive from this
// array rather than recreating command-name sets.
// ---------------------------------------------------------------------------

const RAW_COMMAND_DESCRIPTORS = [
  // -- lease (route: lease) --
  {
    name: 'lease_allocate',
    catalog: { group: 'internal', key: 'leaseAllocate' },
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'lease_heartbeat',
    catalog: { group: 'internal', key: 'leaseHeartbeat' },
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'lease_release',
    catalog: { group: 'internal', key: 'leaseRelease' },
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'artifacts',
    catalog: { group: 'public' },
    daemon: { route: 'lease', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },

  // -- session (route: session) --
  {
    name: 'session_list',
    catalog: { group: 'internal', key: 'sessionList' },
    daemon: { route: 'session', sessionKind: 'inventory', ...REQUEST_EXECUTION_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'devices',
    catalog: { group: 'public' },
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
    name: 'capabilities',
    catalog: { group: 'public' },
    daemon: {
      route: 'session',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      preferExplicitDeviceOverExistingSession: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'doctor',
    catalog: { group: 'public' },
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
    name: 'apps',
    catalog: { group: 'public' },
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
    name: 'boot',
    catalog: { group: 'public' },
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
    name: 'shutdown',
    catalog: { group: 'public' },
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
    name: 'appstate',
    catalog: { group: 'public', key: 'appState' },
    daemon: { route: 'session', sessionKind: 'state' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'perf',
    catalog: { group: 'public' },
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'logs',
    catalog: { group: 'public' },
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'network',
    catalog: { group: 'public' },
    daemon: { route: 'session', sessionKind: 'observability' },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'audio',
    catalog: { group: 'public' },
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
    name: 'replay',
    catalog: { group: 'public' },
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
    name: 'test',
    catalog: { group: 'public' },
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
    name: 'runtime',
    catalog: { group: 'internal' },
    daemon: { route: 'session' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'clipboard',
    catalog: { group: 'public' },
    daemon: { route: 'session', replayScopedAction: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'keyboard',
    catalog: { group: 'public' },
    daemon: { route: 'session', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'install',
    catalog: { group: 'public' },
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'reinstall',
    catalog: { group: 'public' },
    daemon: { route: 'session' },
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'install_source',
    catalog: { group: 'internal', key: 'installSource' },
    daemon: { route: 'session' },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'release_materialized_paths',
    catalog: { group: 'internal', key: 'releaseMaterializedPaths' },
    daemon: { route: 'session', ...REQUEST_EXECUTION_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'push',
    catalog: { group: 'public' },
    daemon: { route: 'session' },
    dispatch: {},
    capability: {
      apple: { simulator: true },
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'trigger-app-event',
    catalog: { group: 'public', key: 'triggerAppEvent' },
    daemon: { route: 'session' },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'open',
    catalog: { group: 'public' },
    daemon: { route: 'session', allowSessionlessDefaultDevice: allowAnyDeviceSessionless },
    dispatch: {},
    capability: APP_RUNTIME_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'prepare',
    catalog: { group: 'public' },
    daemon: { route: 'session' },
    // Runner warm-up builds are the longest fixed envelope; --timeout overrides.
    timeoutPolicy: {
      budget: { source: 'flag' },
      envelopeMs: PREPARE_REQUEST_TIMEOUT_MS,
      onTimeout: 'reset-daemon',
    },
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'batch',
    catalog: { group: 'public' },
    daemon: { route: 'session' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'close',
    catalog: { group: 'public' },
    daemon: { route: 'session', allowInvalidRecording: true },
    dispatch: {},
    capability: APP_RUNTIME_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- snapshot (route: snapshot) --
  {
    name: 'snapshot',
    catalog: { group: 'public' },
    daemon: { route: 'snapshot', replayScopedAction: true },
    dispatch: {},
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    // First Apple snapshot on a device can sit behind runner startup; --timeout
    // widens the envelope, and a timeout must not tear down the daemon.
    timeoutPolicy: { ...PRESERVE_DAEMON_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: true,
  },
  {
    name: 'diff',
    catalog: { group: 'public' },
    daemon: { route: 'snapshot', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'wait',
    catalog: { group: 'public' },
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
    name: 'alert',
    catalog: { group: 'public' },
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
    name: 'settings',
    catalog: { group: 'public' },
    daemon: { route: 'snapshot', replayScopedAction: true },
    dispatch: {},
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
    name: 'react-native',
    catalog: { group: 'public', key: 'reactNative' },
    daemon: { route: 'reactNative', replayScopedAction: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'record',
    catalog: { group: 'public' },
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
    name: 'trace',
    catalog: { group: 'public' },
    daemon: { route: 'recordTrace' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'find',
    catalog: { group: 'public' },
    daemon: { route: 'find', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: PRESERVE_DAEMON_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- interaction (route: interaction) --
  // Interaction commands resolve their target through the same platform accessibility
  // capture as snapshot, so a hung capture is their dominant timeout mode. Resetting the
  // daemon here destroyed every app session the daemon owned while the app itself was
  // still healthy (#1105): keep the daemon (and sessions) alive like snapshot/wait/find,
  // and rely on request cancellation + the per-request runner recycle budget to abort the
  // stuck Apple runner work.
  {
    name: 'click',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: interactionTimeoutPolicy('click'),
    postActionObservation: postActionObservation('click'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
  },
  {
    name: 'fill',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: interactionTimeoutPolicy('fill'),
    postActionObservation: postActionObservation('fill'),
    responseDataTransform: FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
  },
  {
    name: 'longpress',
    catalog: { group: 'public', key: 'longPress' },
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: interactionTimeoutPolicy('longpress'),
    postActionObservation: postActionObservation('longpress'),
    batchable: true,
  },
  {
    name: 'press',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: interactionTimeoutPolicy('press'),
    postActionObservation: postActionObservation('press'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
  },
  {
    name: 'type',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: interactionTimeoutPolicy('type'),
    batchable: true,
  },
  {
    name: 'get',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: interactionTimeoutPolicy('get'),
    batchable: true,
  },
  {
    name: 'read',
    catalog: { group: 'dispatch-alias' },
    dispatch: {},
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'is',
    catalog: { group: 'public' },
    daemon: { route: 'interaction', replayScopedAction: true },
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: interactionTimeoutPolicy('is'),
    batchable: true,
  },

  // -- generic (route: generic) --
  {
    name: 'back',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'gesture',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'home',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_DEVICE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'tv-remote',
    catalog: { group: 'public', key: 'tvRemote' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'rotate',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'scroll',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'swipe',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'swipe-preset',
    catalog: { group: 'dispatch-alias' },
    dispatch: {},
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'pinch',
    catalog: { group: 'dispatch-alias' },
    daemon: { route: 'generic', replayScopedAction: true, androidBlockingDialogGuard: true },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'focus',
    catalog: { group: 'public' },
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'screenshot',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true },
    dispatch: {},
    capability: ALL_DEVICE_COMMAND_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'viewport',
    catalog: { group: 'public' },
    daemon: { route: 'generic', replayScopedAction: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'pan',
    catalog: { group: 'dispatch-alias' },
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_DEVICE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'fling',
    catalog: { group: 'dispatch-alias' },
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    dispatch: {},
    capability: { apple: APPLE_SIM_AND_DEVICE, android: ANDROID_ALL, linux: LINUX_NONE },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'rotate-gesture',
    catalog: { group: 'dispatch-alias' },
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    dispatch: {},
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
    catalog: { group: 'dispatch-alias' },
    daemon: { route: 'generic', androidBlockingDialogGuard: true },
    dispatch: {},
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
    name: 'app-switcher',
    catalog: { group: 'public', key: 'appSwitcher' },
    dispatch: {},
    capability: {
      apple: APPLE_SIM_AND_DEVICE,
      android: ANDROID_ALL,
      linux: LINUX_NONE,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'install-from-source',
    catalog: { group: 'public', key: 'installFromSource' },
    capability: APP_INSTALL_CAPABILITY,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- local client-backed CLI/MCP commands (no daemon route/capability) --
  {
    name: 'debug',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'metro',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'session',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'cdp',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'auth',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'connect',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'connection',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'disconnect',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'mcp',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'proxy',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'react-devtools',
    catalog: { group: 'local-cli', key: 'reactDevtools' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
  {
    name: 'web',
    catalog: { group: 'local-cli' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
  },
] as const satisfies readonly RawCommandDescriptor[];

const CLI_CATALOG_GROUPS = new Set<CommandCatalogGroup>(['public', 'local-cli']);

const CLI_COMMAND_NAMES = new Set<string>(
  RAW_COMMAND_DESCRIPTORS.filter((descriptor) =>
    CLI_CATALOG_GROUPS.has(readCatalogGroup(descriptor)),
  ).map((descriptor) => descriptor.name),
);

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
  mcpExposed: resolveMcpExposure(descriptor),
})) satisfies readonly CommandDescriptor[];

/** The literal union of every registered command name. */
export type Command = (typeof commandDescriptors)[number]['name'];

export function listDescriptorCatalogCommandNames<Group extends CommandCatalogGroup>(
  group: Group,
): Array<DescriptorCommandNameForCatalogGroup<Group>> {
  return listDescriptorCatalogEntries(group)
    .map(([, name]) => name)
    .sort();
}

export function listDescriptorCatalogEntries<Group extends CommandCatalogGroup>(
  group: Group,
): Array<readonly [key: string, name: DescriptorCommandNameForCatalogGroup<Group>]> {
  return commandDescriptors
    .filter((descriptor) => readCatalogGroup(descriptor) === group)
    .map(
      (descriptor) =>
        [
          readCatalogKey(descriptor),
          descriptor.name as DescriptorCommandNameForCatalogGroup<Group>,
        ] as const,
    );
}

export function listDescriptorDispatchCommandNames(): DescriptorDispatchCommandName[] {
  return commandDescriptors
    .filter((descriptor) => 'dispatch' in descriptor && descriptor.dispatch !== undefined)
    .map((descriptor) => descriptor.name as DescriptorDispatchCommandName)
    .sort();
}

export function listMcpExposedCommandNames(): DescriptorCliCommandName[] {
  return commandDescriptors
    .filter((descriptor) => isMcpExposedCliCommand(descriptor))
    .map((descriptor) => descriptor.name as DescriptorCliCommandName)
    .sort();
}

export function listCapabilityCheckedCommandNames(): DescriptorCliCommandName[] {
  return commandDescriptors
    .filter((descriptor) => isCapabilityCheckedCliCommand(descriptor))
    .map((descriptor) => descriptor.name as DescriptorCliCommandName)
    .sort();
}

const COMMAND_DESCRIPTOR_BY_NAME: ReadonlyMap<string, CommandDescriptor> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);

function isCliCommandName(command: string): command is DescriptorCliCommandName {
  return CLI_COMMAND_NAMES.has(command);
}

function resolveMcpExposure(descriptor: RawCommandDescriptor): boolean {
  return descriptor.mcpExposed ?? CLI_COMMAND_NAMES.has(descriptor.name);
}

function isMcpExposedCliCommand(descriptor: CommandDescriptor): boolean {
  return descriptor.mcpExposed && isCliCommandName(descriptor.name);
}

function isCapabilityCheckedCliCommand(descriptor: CommandDescriptor): boolean {
  return Boolean(descriptor.capability) && isCliCommandName(descriptor.name);
}

function readCatalogGroup(descriptor: {
  name: string;
  catalog: { group: CommandCatalogGroup; key?: string };
}): CommandCatalogGroup {
  return descriptor.catalog.group;
}

function readCatalogKey(descriptor: {
  name: string;
  catalog: { group: CommandCatalogGroup; key?: string };
}): string {
  return descriptor.catalog.key ?? descriptor.name;
}

const TIMEOUT_POLICY_BY_COMMAND: ReadonlyMap<string, CommandTimeoutPolicy> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor.timeoutPolicy]),
);

const RESPONSE_DATA_TRANSFORM_BY_COMMAND: ReadonlyMap<string, CommandResponseDataTransform> =
  new Map(
    Array.from(COMMAND_DESCRIPTOR_BY_NAME.values()).flatMap((descriptor) =>
      descriptor.responseDataTransform
        ? [[descriptor.name, descriptor.responseDataTransform] as const]
        : [],
    ),
  );

export function resolveCommandPostActionObservationSupport(
  command: string | undefined,
): PostActionObservationSupport | undefined {
  if (command === undefined) return undefined;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.postActionObservation;
}

export function commandSupportsSettleObservation(command: string | undefined): boolean {
  return resolveCommandPostActionObservationSupport(command) !== undefined;
}

export function commandSupportsVerifyEvidence(command: string | undefined): boolean {
  return resolveCommandPostActionObservationSupport(command) === 'settle-and-verify';
}

/**
 * The declared timeout policy for a command (ADR 0008). Command names outside
 * the registry (internal probes, unknown commands) fall back to
 * {@link DEFAULT_TIMEOUT_POLICY} — standard envelope, reset-daemon — exactly as
 * the deleted hand lists treated unlisted commands.
 */
export function resolveCommandTimeoutPolicy(command: string | undefined): CommandTimeoutPolicy {
  if (command === undefined) return DEFAULT_TIMEOUT_POLICY;
  return TIMEOUT_POLICY_BY_COMMAND.get(command) ?? DEFAULT_TIMEOUT_POLICY;
}

export function resolveCommandResponseDataTransform(
  command: string | undefined,
): CommandResponseDataTransform | undefined {
  if (command === undefined) return undefined;
  return RESPONSE_DATA_TRANSFORM_BY_COMMAND.get(command);
}

export function listCommandResponseDataTransforms(): Array<{
  command: string;
  transform: CommandResponseDataTransform;
}> {
  return Array.from(RESPONSE_DATA_TRANSFORM_BY_COMMAND, ([command, transform]) => ({
    command,
    transform,
  }));
}

export function listCommandResponseDataTransformFieldNames(): string[] {
  return [
    ...new Set(
      Array.from(RESPONSE_DATA_TRANSFORM_BY_COMMAND.values()).flatMap((transform) =>
        Object.keys(transform.fields),
      ),
    ),
  ].sort();
}
