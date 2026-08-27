// The typed-flags request from contracts/, not the daemon's server-side refinement: these
// descriptors read `command`, `positionals` and `flags` and never touch `internal`.
import type { DispatchedCommand } from '@agent-device/contracts/command';
import type { RefFrameEffect } from '@agent-device/contracts/replay';
import { isReadOnlyFindAction, parseFindArgs } from '@agent-device/selectors';
import { resolveWaitBudgetMs } from '../wait-positionals.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
  PREPARE_REQUEST_TIMEOUT_MS,
} from './timeout-policy.ts';
import { resolvePostActionObservationSupport } from './post-action-observation.ts';
import type { PostActionObservationSupport } from './post-action-observation.ts';
import {
  deployAppUse,
  readyMaterializeAndDeployAppUse,
  readySendPushNotificationUse,
} from '@agent-device/contracts/app-deployment-runtime-plan';
import {
  closeApplicationRuntimePlanUses,
  openApplicationRuntimePlanUses,
  prepareAppleRunnerRuntimeUse,
  runtimeCommandRuntimePlanUses,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { appLogRuntimePlanUses } from '@agent-device/contracts/logs-runtime-plan';
import { audioRuntimePlanUses } from '@agent-device/contracts/audio-runtime-plan';
import { networkDumpUse } from '@agent-device/contracts/network-runtime-plan';
import { inventoryUse } from '@agent-device/contracts/platform-module';
import {
  appsRuntimeUse,
  appStateRuntimeUses,
  backRuntimeUse,
  clickRuntimeUses,
  deviceBootRuntimeUses,
  fillRuntimeUses,
  findRuntimePlanUses,
  focusRuntimeUse,
  gestureRuntimePlanUses,
  gestureViewportRuntimeUse,
  homeRuntimeUse,
  hoverRuntimeUses,
  appEventRuntimeUse,
  settingsRuntimeUse,
  alertRuntimePlanUses,
  appSwitcherRuntimeUse,
  tapPointUse,
  clipboardRuntimePlanUses,
  keyboardRuntimePlanUses,
  longPressRuntimeUses,
  orientationRuntimeUse,
  perfRuntimePlanUses,
  pressRuntimeUses,
  screenshotRuntimePlanUses,
  scrollRuntimePlanUses,
  swipeRuntimePlanUses,
  selectorCaptureRuntimePlanUses,
  selectorTextCaptureRuntimePlanUses,
  shutdownTargetUse,
  snapshotRuntimePlanUses,
  tvRemoteRuntimeUse,
  typeTextRuntimeUse,
  viewportRuntimeUse,
  waitSelectorCaptureRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { assertRecordRuntimeExecution } from '@agent-device/contracts/record-runtime-execution';
import { screenRecordingRuntimePlanUses } from '@agent-device/contracts/screen-recording-runtime-plan';
import { readDeclaredPlatformExecution } from './platform-execution-entry.ts';
import type {
  CommandCatalogGroup,
  CommandDescriptor,
  CommandFrameworkTier,
  DeviceClaimPolicy,
  RecordingEffect,
  CommandResponseDataTransform,
  CommandTimeoutPolicy,
  TargetIdentityVerification,
} from './types.ts';

// `platformExecution` stays REQUIRED here (ADR 0019 §6): a raw descriptor that omits it
// is a compile error, and {@link readDeclaredPlatformExecution} is the matching runtime gate.
type RawCommandDescriptorShape<T> = T extends CommandDescriptor
  ? Omit<T, 'mcpExposed'> & {
      mcpExposed?: boolean;
      ownerFiles?: readonly [string, ...string[]];
    }
  : never;
type RawCommandDescriptor = RawCommandDescriptorShape<CommandDescriptor>;

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
  readonly [
    Descriptor in Extract<
      (typeof commandDescriptors)[number],
      { name: string }
    > as RawCommandCatalogGroup<Descriptor> extends Group ? RawCommandCatalogKey<Descriptor> : never
  ]: Descriptor['name'];
};

/**
 * The literal union of every command whose `daemon.route` is `'session'`.
 * Drives `SESSION_COMMAND_HANDLER_IMPLS` in `src/daemon/handlers/session.ts`: adding a
 * session-routed descriptor without a matching handler table entry is a compile error rather
 * than a runtime routing gap caught only by `expectHandlerResponse`.
 */
export type DescriptorSessionRouteCommandName =
  Extract<
    (typeof commandDescriptors)[number],
    { daemon: { route: 'session' } }
  > extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? Name
      : never
    : never;

/**
 * The literal union of every command the daemon routes. A command that never reaches a
 * daemon route cannot be the target of a request, so this is the type a caller building
 * one must name — an unregistered or CLI-only target is a compile error rather than a
 * string the receiver rejects at runtime.
 */
export type DescriptorDaemonRouteCommandName =
  Extract<(typeof commandDescriptors)[number], { daemon: object }> extends infer Descriptor
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

const isRecordingStartRequest = (req: DispatchedCommand): boolean =>
  (req.positionals?.[0] ?? '').toLowerCase() === 'start';

const isShardedTestRequest = (req: DispatchedCommand): boolean =>
  req.command === 'test' &&
  (typeof req.flags?.shardAll === 'number' || typeof req.flags?.shardSplit === 'number');

// #2016: a plain `close` (no app-target positional) has nothing to close via
// flags, so it's the only close shape eligible for the sessionless
// no-lease-anywhere admission bypass in request-admission.ts. `close <app>`
// resolves its device straight from flags when there's no session and must
// stay behind full lease/tenant admission.
const isPlainCloseRequest = (req: DispatchedCommand): boolean =>
  (req.positionals?.length ?? 0) === 0;

// ADR 0014 request-sensitive ref-frame resolvers. The action is the leading
// positional (see keyboard/alert daemon writers in src/commands/system/index.ts
// and src/commands/capture/alert.ts). Only the read-only status probes preserve
// the frame; every mutating subaction crosses a device side effect.
//
// keyboard actions are status/get/dismiss/enter/return (src/commands/system/
// runtime/system.ts): status/get inspect, while dismiss hides the keyboard and
// enter/return dispatch a real return key. Anything other than a read is
// classified may-invalidate (the honest superset for unknown subactions).
const KEYBOARD_READ_ONLY_ACTIONS = new Set(['status', 'get']);
const keyboardRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

// alert actions are get/wait/accept/dismiss: get/wait read, accept/dismiss act.
const ALERT_READ_ONLY_ACTIONS = new Set(['get', 'wait']);
const alertRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

const keyboardRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

const alertRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

const findRecordingEffect = (req: DispatchedCommand): RecordingEffect => {
  try {
    return isReadOnlyFindAction(parseFindArgs(req.positionals ?? []).action)
      ? 'observes-app'
      : 'mutates-app';
  } catch {
    // Invalid requests never record, but classify the unknown shape conservatively.
    return 'mutates-app';
  }
};

function readOnlySubactionRefFrameEffect(
  req: DispatchedCommand,
  readOnlyActions: ReadonlySet<string>,
  defaultAction: string,
): RefFrameEffect {
  return readOnlyActions.has((req.positionals?.[0] ?? defaultAction).toLowerCase())
    ? 'preserve'
    : 'may-invalidate';
}

function readOnlySubactionRecordingEffect(
  req: DispatchedCommand,
  readOnlyActions: ReadonlySet<string>,
  defaultAction: string,
): RecordingEffect {
  return readOnlyActions.has((req.positionals?.[0] ?? defaultAction).toLowerCase())
    ? 'observes-app'
    : 'mutates-app';
}

const NO_PLATFORM_EXECUTION = { kind: 'none' } as const;
// Host-scoped platform work (ADR 0019): the descriptor consumes a neutral typed host service and
// binds no device runtime of its own.
const HOST_PLATFORM_EXECUTION = { kind: 'host' } as const;

/**
 * The daemon/recording traits every generic-route mutating command shares. The legacy execution
 * pair it was split from (`dispatch`/`capability`) is gone: `scroll` was its last consumer, and
 * R53 migrated it, so every generic-route mutating command now spreads this alone.
 */
const GENERIC_MUTATING_COMMAND_TRAITS = {
  recordsSessionAction: true,
  recordingEffect: 'mutates-app',
  deviceClaimPolicy: 'require-owner',
  daemon: {
    route: 'generic',
    refFrameEffect: 'may-invalidate',
    androidBlockingDialogGuard: true,
  },
  timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
  batchable: true,
} as const satisfies Pick<
  Extract<CommandDescriptor, { recordsSessionAction: true }>,
  | 'recordsSessionAction'
  | 'recordingEffect'
  | 'deviceClaimPolicy'
  | 'daemon'
  | 'timeoutPolicy'
  | 'batchable'
>;

// click/fill/press/longpress differ only in their timeout budget and response
// shaping: same owner file, same pre-dispatch target identity, same interaction
// route and dialog guard, same device buckets, and the same session-bound claim
// policy. Sharing that here is what keeps them from drifting apart one field at
// a time.
const TARGETED_TOUCH_INTERACTION_TRAITS = {
  targetIdentityVerification: 'pre-dispatch',
  catalog: { group: 'public' },
  recordsSessionAction: true,
  recordingEffect: 'mutates-app',
  deviceClaimPolicy: 'require-owner',
  daemon: {
    route: 'interaction',
    refFrameEffect: 'may-invalidate',
    androidBlockingDialogGuard: true,
  },
} as const satisfies Pick<
  Extract<CommandDescriptor, { recordsSessionAction: true }>,
  | 'targetIdentityVerification'
  | 'catalog'
  | 'recordsSessionAction'
  | 'recordingEffect'
  | 'deviceClaimPolicy'
  | 'daemon'
>;

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

// Lease-route commands act on billed cloud sessions the daemon owns; resetting
// the daemon on a client timeout would SIGKILL it mid-create/mid-release and
// orphan them all (#1774). Allocation also gets an envelope sized for remote
// device allocation (see LEASE_ALLOCATION_BUDGET_MS).
const LEASE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};
const LEASE_ALLOCATE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...LEASE_TIMEOUT_POLICY,
  envelopeMs: LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
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

/**
 * A settle-capable command spends its `--timeout` on the post-action wait, so
 * the envelope has to widen by that budget wherever the trait is declared —
 * interaction route or generic route (#1638). `withoutObservation` is the
 * policy the command would carry if the trait were dropped, so removing a
 * trait restores the command's own envelope instead of silently leaving it on
 * the settle one.
 */
function postActionObservationTimeoutPolicy(
  command: string,
  withoutObservation: CommandTimeoutPolicy,
): CommandTimeoutPolicy {
  return resolvePostActionObservationSupport(command) !== undefined
    ? SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY
    : withoutObservation;
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

const ownerFilesEnabled = typeof __OWNER_FILES__ === 'undefined' || __OWNER_FILES__;

export const RAW_COMMAND_DESCRIPTORS = [
  // -- lease (route: lease) --
  {
    name: 'lease_allocate',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseAllocate' },
    recordsSessionAction: false,
    daemon: { route: 'lease', refFrameEffect: 'preserve', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: LEASE_ALLOCATE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'lease_heartbeat',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseHeartbeat' },
    recordsSessionAction: false,
    daemon: { route: 'lease', refFrameEffect: 'preserve', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: LEASE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'lease_release',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseRelease' },
    recordsSessionAction: false,
    daemon: { route: 'lease', refFrameEffect: 'preserve', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: LEASE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'artifacts',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/artifacts.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'lease', refFrameEffect: 'preserve', ...ADMISSION_AND_LOCK_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },

  // -- session (route: session) --
  {
    name: 'session_list',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-inventory.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'sessionList' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'session_save_script',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-script-publication.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'sessionSaveScript' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'publication',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'devices',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/device.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'inventory', use: inventoryUse },
  },
  {
    name: 'capabilities',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/device.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      preferExplicitDeviceOverExistingSession: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    // R63: `capabilities` executes nothing on a device. It reads one side-effect-free facts
    // inspection and projects each command's own declared uses against it, so it has no platform
    // execution path of its own to migrate — which is what `none` states. It is deliberately last
    // among the command units: it projects the union of every migrated command's facts, so it is
    // only truthful once that surface is complete.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'doctor',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/doctor.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      allowSessionlessDefaultDevice: allowAnyDeviceSessionless,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: HOST_PLATFORM_EXECUTION,
  },
  {
    name: 'apps',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/app.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      lockPolicySelectorOverride: true,
      preferExplicitDeviceOverExistingSession: true,
    },
    platformExecution: { kind: 'device-runtime', uses: [appsRuntimeUse] as const },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'boot',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/device.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'may-invalidate', sessionKind: 'state' },
    platformExecution: { kind: 'device-runtime', uses: deviceBootRuntimeUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'shutdown',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/device.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'may-invalidate', sessionKind: 'state' },
    platformExecution: { kind: 'device-runtime', use: shutdownTargetUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'appstate',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'appState' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve', sessionKind: 'state' },
    platformExecution: { kind: 'device-runtime', uses: appStateRuntimeUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'perf',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/perf/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'session', refFrameEffect: 'preserve', sessionKind: 'observability' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: perfRuntimePlanUses },
  },
  {
    name: 'logs',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve', sessionKind: 'observability' },
    platformExecution: { kind: 'device-runtime', uses: appLogRuntimePlanUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'events',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
      allowInvalidRecording: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: `events` flushes and reads the session's own event log. It touches no
    // device at all, so it has no platform execution path to migrate.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'network',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve', sessionKind: 'observability' },
    platformExecution: { kind: 'device-runtime', use: networkDumpUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'audio',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve', sessionKind: 'observability' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: audioRuntimePlanUses },
  },
  {
    name: 'replay',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/replay/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'delegated',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
      saveScriptFlagOwner: true,
    },
    // Replay durations are script-dependent; --timeout bounds the envelope.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: false,
    // Every native and Maestro action re-enters the daemon request pipeline under the delegated
    // command descriptor. Maestro viewport reads do the same through `runtime gesture-viewport`,
    // so replay owns orchestration but no platform execution of its own.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'test',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/replay/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'delegated',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    // Test runs stream per-scenario progress and are budgeted downstream; no
    // client envelope at all.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, envelopeMs: 'unbounded' },
    batchable: true,
    // Test is suite orchestration over replay attempts; each attempt delegates its admitted
    // operations, including Maestro viewport acquisition, to their own descriptors.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'runtime',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'src/daemon/handlers/session-runtime-command.ts',
            'src/daemon/handlers/session-runtime-port-reverse.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'internal' },
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: {
      kind: 'device-runtime',
      uses: [...runtimeCommandRuntimePlanUses, gestureViewportRuntimeUse],
    },
  },
  {
    name: 'clipboard',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R55 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // whichever action-selected fact (`readClipboard`/`writeClipboard`) the parsed subcommand
    // names, and the only execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: clipboardRuntimePlanUses },
  },
  {
    name: 'keyboard',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R46 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // whichever action-selected fact (`keyboardStatus`/`keyboardDismiss`/`keyboardEnter`) the
    // parsed action names, and the only execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: keyboardRecordingEffect,
    daemon: {
      route: 'session',
      refFrameEffect: keyboardRefFrameEffect,
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: keyboardRuntimePlanUses },
  },
  {
    name: 'install',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/install.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: deployAppUse },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'reinstall',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/install.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: deployAppUse },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'install_source',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-app-source-deployment.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'installSource' },
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: readyMaterializeAndDeployAppUse },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'release_materialized_paths',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-app-source-deployment.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'releaseMaterializedPaths' },
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve', ...REQUEST_EXECUTION_EXEMPT },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'push',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/push.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: readySendPushNotificationUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'trigger-app-event',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/push.ts'] as const } : {}),
    catalog: { group: 'public', key: 'triggerAppEvent' },
    frameworkTier: 'extended',
    // R57 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `triggerAppEvent` fact, and the only execution is that one bound operation. The
    // event name, payload, and URL template stay daemon policy (ADR 0019 §2 — a facet input names
    // no command, request, or CLI flag), so the owner receives a URL to open.
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [appEventRuntimeUse] },
  },
  {
    name: 'open',
    deviceClaimPolicy: 'acquire-session',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/app.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'may-invalidate',
      allowSessionlessDefaultDevice: allowAnyDeviceSessionless,
      saveScriptFlagOwner: true,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: openApplicationRuntimePlanUses },
  },
  {
    name: 'prepare',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/prepare.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    // Runner warm-up builds are the longest fixed envelope; --timeout overrides.
    timeoutPolicy: {
      budget: { source: 'flag' },
      envelopeMs: PREPARE_REQUEST_TIMEOUT_MS,
      onTimeout: 'reset-daemon',
    },
    batchable: false,
    mcpExposed: false,
    platformExecution: { kind: 'device-runtime', use: prepareAppleRunnerRuntimeUse },
  },
  {
    name: 'batch',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/batch/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'delegated' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: every step runs as its own daemon request under its own descriptor, which
    // is what `refFrameEffect: 'delegated'` already says. `batch` itself reaches no device.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'close',
    deviceClaimPolicy: 'release-session',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/app.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'may-invalidate',
      allowInvalidRecording: true,
      saveScriptFlagOwner: true,
      sessionlessPlainCloseAdmissionExempt: isPlainCloseRequest,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: closeApplicationRuntimePlanUses },
  },

  // -- snapshot (route: snapshot) --
  {
    name: 'snapshot',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/snapshot.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    // First Apple snapshot on a device can sit behind runner startup; --timeout
    // widens the envelope, and a timeout must not tear down the daemon.
    timeoutPolicy: { ...PRESERVE_DAEMON_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: snapshotRuntimePlanUses },
  },
  {
    name: 'diff',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/diff.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: snapshotRuntimePlanUses },
  },
  {
    name: 'wait',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/wait.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    // #1349: a wait's landmark may legitimately be absent when the step
    // starts, so identity verification runs inside its polling resolution.
    targetIdentityVerification: 'post-resolution',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    // The wait budget travels as a positional, not a flag; parse it the same
    // way the daemon will so the request envelope extends past it (#1075).
    timeoutPolicy: {
      ...PRESERVE_DAEMON_TIMEOUT_POLICY,
      budget: { source: 'positional-parser', parser: resolveWaitBudgetMs },
    },
    batchable: true,
    // A duration wait declares no operation and never binds (`waitObservesDevice`); every
    // observing shape uses the wait-specific capture plan so its conditional native observations
    // cannot affect capture-only or element-text selector commands.
    //
    // ACCEPTED BEHAVIOUR CHANGE (#1875, ruled rather than assumed): binding the family plan means
    // wait asks the owner whether it can observe a device with no app attached, and the families
    // answer differently. On iOS `appBundleId` is the XCUITest attach target, so with none set
    // local Apple refuses `captureSnapshotWithoutActiveApp` and wait now fails immediately naming
    // `open`, where it used to poll to its deadline. It could never have succeeded: the runner's
    // own process foregrounds and displaces the app under test, then answers about its own blank
    // screen — so `wait stable` and `wait @ref` stopped returning a success that was describing
    // the runner, not the app. Android captures the real launcher in that state, its facts say
    // so, and wait proceeds unchanged. Same plan, opposite outcomes, chosen by the owner.
    platformExecution: { kind: 'device-runtime', uses: waitSelectorCaptureRuntimePlanUses },
  },
  {
    name: 'alert',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/alert.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    // R59 retires this command's capability bucket and its Apple `supportsAlertSurface` closure
    // together: admission is the owner's own alert facts, and the only execution is the one bound
    // leg the parsed subcommand names. The poll and retry windows moved to the owners with it —
    // how long a transient sheet takes to appear is family mechanics, not request policy.
    recordsSessionAction: true,
    recordingEffect: alertRecordingEffect,
    daemon: { route: 'snapshot', refFrameEffect: alertRefFrameEffect },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: alertRuntimePlanUses },
  },
  {
    name: 'settings',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/settings.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R58 retires this command's capability bucket, its `dispatch` leaf, and its HarmonyOS
    // overlay membership together: admission is the owner's `setSetting` fact, and the only
    // execution is that one bound operation. The macOS setting-name gate stays daemon-side —
    // it keys on the requested setting, which is not a device fact.
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'snapshot', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [settingsRuntimeUse] },
  },

  // -- specialized routes --
  {
    name: 'react-native',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/react-native/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'reactNative' },
    frameworkTier: 'extended',
    // R61 retires this command's capability bucket: admission is the owner's own `tapPoint` fact,
    // which is the one device operation the command executes. The overlay analysis and its
    // verification capture are daemon policy over an already-migrated snapshot route.
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'reactNative', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [tapPointUse] },
  },
  {
    name: 'record',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/recording/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: {
      route: 'recordTrace',
      refFrameEffect: 'preserve',
      allowInvalidRecording: true,
      allowSessionlessDefaultDevice: isRecordingStartRequest,
    },
    platformExecution: { kind: 'device-runtime', uses: screenRecordingRuntimePlanUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'trace',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/recording/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'recordTrace', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'find',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: findRecordingEffect,
    daemon: { route: 'find', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: PRESERVE_DAEMON_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: findRuntimePlanUses },
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
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: postActionObservationTimeoutPolicy('click', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('click'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: clickRuntimeUses },
  },
  {
    name: 'fill',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    frameworkTier: 'core',
    timeoutPolicy: postActionObservationTimeoutPolicy('fill', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('fill'),
    responseDataTransform: FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: fillRuntimeUses },
  },
  {
    name: 'longpress',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    catalog: { group: 'public', key: 'longPress' },
    frameworkTier: 'extended',
    timeoutPolicy: {
      ...SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY,
      // Android's cold path may inspect/install the helper, hand off a running
      // snapshot helper, hold for 120 seconds, then use 15 seconds of helper
      // completion overhead. Keep that complete route inside the envelope.
      envelopeMs: 210_000,
    },
    postActionObservation: postActionObservation('longpress'),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: longPressRuntimeUses },
  },
  {
    name: 'hover',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
    },
    timeoutPolicy: postActionObservationTimeoutPolicy('hover', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('hover'),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: hoverRuntimeUses },
  },
  {
    name: 'press',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    frameworkTier: 'core',
    timeoutPolicy: postActionObservationTimeoutPolicy('press', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('press'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: pressRuntimeUses },
  },
  {
    name: 'type',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: postActionObservationTimeoutPolicy('type', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [typeTextRuntimeUse] },
  },
  {
    name: 'get',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'interaction', refFrameEffect: 'preserve' },
    timeoutPolicy: postActionObservationTimeoutPolicy('get', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: selectorTextCaptureRuntimePlanUses },
  },
  {
    name: 'is',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'interaction', refFrameEffect: 'preserve' },
    timeoutPolicy: postActionObservationTimeoutPolicy('is', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: selectorCaptureRuntimePlanUses },
  },

  // -- generic (route: generic) --
  {
    name: 'back',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    // R42 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `back` fact, and the only execution is the bound operation — the postActionObservation
    // timeout trait it kept is admission-independent, like `type` kept its dialog guard.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    timeoutPolicy: postActionObservationTimeoutPolicy('back', DEFAULT_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('back'),
    platformExecution: { kind: 'device-runtime', uses: [backRuntimeUse] },
  },
  {
    name: 'gesture',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    targetIdentityVerification: 'pre-dispatch',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    // R52 retires this command's capability bucket: admission is the owner's gesture-tier facts,
    // which the retired `requireGestureSupported` used to decide inside the daemon. The declared
    // uses are the four tiers one gesture input can select between (ADR 0019 §9).
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: gestureRuntimePlanUses },
  },
  {
    name: 'home',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R43 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `home` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [homeRuntimeUse] },
  },
  {
    name: 'tv-remote',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'tvRemote' },
    frameworkTier: 'extended',
    // R45 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `tvRemote` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [tvRemoteRuntimeUse] },
  },
  {
    name: 'orientation',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R44 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `setOrientation` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [orientationRuntimeUse] },
  },
  {
    name: 'scroll',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/scroll-runtime.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    // R53 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `scrollDirection` fact, and the only execution is the bound operation. `scroll`
    // was the last holder of the legacy `dispatch`/`capability` pair, which retires with it.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    timeoutPolicy: postActionObservationTimeoutPolicy('scroll', DEFAULT_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('scroll'),
    platformExecution: { kind: 'device-runtime', uses: scrollRuntimePlanUses },
  },
  {
    name: 'swipe',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    // R54 retires this command's capability bucket. A swipe always normalizes to a coordinate
    // fling, so it declares only the one-contact plan it can select.
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: swipeRuntimePlanUses },
  },
  {
    name: 'focus',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R40 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `focusPoint` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [focusRuntimeUse] },
  },
  {
    name: 'screenshot',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'src/commands/capture/screenshot.ts',
            'src/daemon/screenshot-runtime.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'generic', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: screenshotRuntimePlanUses },
  },
  {
    name: 'viewport',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/viewport.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'generic', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: { kind: 'device-runtime', uses: [viewportRuntimeUse] },
  },
  // -- capability/batch-only commands (no daemon route) --
  {
    name: 'app-switcher',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'appSwitcher' },
    frameworkTier: 'extended',
    // R56 retires this command's capability bucket, its `dispatch` leaf, and its HarmonyOS
    // overlay membership together: admission is the owner's `appSwitcher` fact, and the only
    // execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    // ADR 0014: app-switcher previously reached the generic daemon leaf via the
    // registry's generic fallback with no daemon facet, so it could not be
    // classified. Add the facet (route unchanged) so its device mutation is
    // covered by the completeness gate; this is the escape hatch the ADR calls
    // out, not a new specialized route.
    daemon: { route: 'generic', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [appSwitcherRuntimeUse] },
  },
  {
    name: 'install-from-source',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/install.ts'] as const } : {}),
    catalog: { group: 'public', key: 'installFromSource' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    platformExecution: { kind: 'device-runtime', use: readyMaterializeAndDeployAppUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },

  // -- local client-backed CLI/MCP commands (no daemon route/capability) --
  {
    name: 'debug',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/debugging/index.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: this route reads local diagnostics files and has no daemon route, no
    // platform import, and no injected dispatch — it was `legacy` only because the discriminator
    // pass had nothing better to say about it.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'daemon',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/daemon.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // `stop --clean` reconciles owner-scoped Apple runner resources through the neutral
    // daemon-owner cleanup service. It is host execution, not a request-bound device operation.
    platformExecution: HOST_PLATFORM_EXECUTION,
  },
  {
    name: 'device',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/device.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'metro',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/metro/index.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'session',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/session.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'cdp',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/agent-cdp.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'auth',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/auth.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'connect',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'connection',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'disconnect',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/connection.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'mcp',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/bin.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'proxy',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/proxy.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'react-devtools',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/react-devtools.ts'] as const } : {}),
    catalog: { group: 'local-cli', key: 'reactDevtools' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // Wave 6 residue: `react-devtools start` on a Limrun Android instance dispatches internal
    // `runtime port-reverse` through the CLI-injected dispatch seam. `runtime` is itself fully
    // migrated (`device-runtime`, R31), so the dispatched execution is accounted for under its
    // own descriptor rather than hidden behind this one — this route owns no unmigrated platform
    // execution of its own. The CLI-route dominance gate
    // (`__tests__/platform-execution-cli-route.test.ts`) still rejects a `none` route whose
    // CLI-injected dispatch target is still `legacy`.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'web',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/cli/commands/web.ts'] as const } : {}),
    catalog: { group: 'local-cli' },
    recordsSessionAction: false,
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    mcpExposed: false,
    // setup/doctor mutate and inspect the managed browser installed on this host through the
    // neutral managed-web-backend service. Live web sessions remain device-runtime owned.
    platformExecution: HOST_PLATFORM_EXECUTION,
  },
] as const satisfies readonly RawCommandDescriptor[];

/**
 * Compile-time owner-claim totality. `keyof` on a union contains only keys
 * shared by every member, so removing `ownerFiles` from any raw descriptor
 * makes this resolve to `false` and fail the `AssertTrue` constraint.
 */
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type CommandOwnerFileClaimsAreComplete = AssertTrue<
  'ownerFiles' extends keyof (typeof RAW_COMMAND_DESCRIPTORS)[number] ? true : false
>;

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
export const commandDescriptors = RAW_COMMAND_DESCRIPTORS.map((descriptor) => {
  const platformExecution = readDeclaredPlatformExecution(descriptor);
  if (descriptor.name === 'record') assertRecordRuntimeExecution(platformExecution);
  if (!ownerFilesEnabled) {
    return {
      ...descriptor,
      mcpExposed: resolveMcpExposure(descriptor),
      platformExecution,
    };
  }

  const { ownerFiles: _, ...runtimeDescriptor } = descriptor;
  return {
    ...runtimeDescriptor,
    mcpExposed: resolveMcpExposure(descriptor),
    platformExecution,
  };
}) satisfies readonly CommandDescriptor[];

/** The literal union of every registered command name. */
export type Command = (typeof commandDescriptors)[number]['name'];

/**
 * @internal Introspection helper used by parity tests.
 */
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

export function listMcpExposedCommandNames(): DescriptorCliCommandName[] {
  return commandDescriptors
    .filter((descriptor) => isMcpExposedCliCommand(descriptor))
    .map((descriptor) => descriptor.name as DescriptorCliCommandName)
    .sort();
}

export function commandRuntimeUseRequirements(
  command: string,
): readonly (readonly string[])[] | undefined {
  const descriptor = commandDescriptors.find((candidate) => candidate.name === command);
  const execution = descriptor?.platformExecution;
  if (execution?.kind !== 'device-runtime') return undefined;
  const uses = 'uses' in execution ? execution.uses : [execution.use];
  return uses.map((use) => use.required);
}

export function listRuntimeFactCommands(): string[] {
  return commandDescriptors
    .filter(
      (descriptor) =>
        descriptor.catalog.group === 'public' &&
        descriptor.platformExecution.kind === 'device-runtime',
    )
    .map((descriptor) => descriptor.name)
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

const DEVICE_CLAIM_POLICY_BY_COMMAND: ReadonlyMap<string, DeviceClaimPolicy> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor.deviceClaimPolicy]),
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

/**
 * The declared #1320 device-claim policy for a command. Names outside the
 * registry (internal probes, unknown commands) resolve to `require-owner`: the
 * value that performs no claim-store I/O at the binding seam, so an
 * unregistered name can neither acquire nor be refused a claim.
 */
export function resolveCommandDeviceClaimPolicy(command: string | undefined): DeviceClaimPolicy {
  if (command === undefined) return 'require-owner';
  return DEVICE_CLAIM_POLICY_BY_COMMAND.get(command) ?? 'require-owner';
}

export function resolveCommandResponseDataTransform(
  command: string | undefined,
): CommandResponseDataTransform | undefined {
  if (command === undefined) return undefined;
  return RESPONSE_DATA_TRANSFORM_BY_COMMAND.get(command);
}

export function resolveCommandRecordsSessionAction(command: string | undefined): boolean {
  if (command === undefined) return false;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.recordsSessionAction ?? false;
}

/**
 * The declared {@link CommandFrameworkTier} for a public command, or
 * `undefined` for a command that never declares one (every non-public
 * command, by construction — see the parity test). Framework adapters
 * (`agent-device/ai-sdk`, `@agent-device/eve`) read this to build their
 * default tool set instead of hand-listing tool names.
 */
export function resolveCommandFrameworkTier(
  command: string | undefined,
): CommandFrameworkTier | undefined {
  if (command === undefined) return undefined;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.frameworkTier;
}

/**
 * ADR 0012 / #1349: the replay verification phase for one command's recorded
 * `target-v1` evidence, or `undefined` for a command whose steps never carry
 * it (an annotation on such a step is inert, exactly like an old reader).
 */
export function resolveTargetIdentityVerification(
  command: string,
): TargetIdentityVerification | undefined {
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.targetIdentityVerification;
}

/** ADR 0016 request-sensitive app-state effect for one recorded request. */
export function resolveCommandRecordingEffect(req: DispatchedCommand): RecordingEffect | undefined {
  const descriptor = COMMAND_DESCRIPTOR_BY_NAME.get(req.command);
  if (!descriptor?.recordsSessionAction) return undefined;
  return typeof descriptor.recordingEffect === 'function'
    ? descriptor.recordingEffect(req)
    : descriptor.recordingEffect;
}

/**
 * @internal Introspection helper used by parity tests.
 */
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
