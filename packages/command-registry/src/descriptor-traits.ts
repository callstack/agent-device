import {
  checkFindArgs,
  isReadOnlyFindAction,
  parseFindArgs,
  type FindAction,
} from '@agent-device/selectors';
import { deployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import type { DispatchedCommand } from '@agent-device/contracts/command';
import type {
  RuntimeUseStep,
  RuntimeUseStepSelector,
} from '@agent-device/contracts/command-platform-execution';
import {
  findRuntimeIntent,
  findRuntimePlanUses,
  resolveSelectorCaptureRuntimePlan,
  resolveSettingsRuntimePlan,
  resolveSnapshotRuntimePlan,
} from '@agent-device/contracts/platform-runtime-operations';
import type { RefFrameEffect } from '@agent-device/contracts/replay';
import type { DaemonCommandDescriptor } from './daemon-command-descriptor.ts';
import {
  resolvePostActionObservationSupport,
  type PostActionObservationSupport,
} from './post-action-observation.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
} from './timeout-policy.ts';
import type {
  CommandDescriptor,
  CommandResponseDataTransform,
  CommandTimeoutPolicy,
  RecordingEffect,
} from './types.ts';

// `platformExecution` stays REQUIRED here (ADR 0019 §6): a raw descriptor that omits it
// is a compile error, and {@link readDeclaredPlatformExecution} is the matching runtime gate.
type RawCommandDescriptorShape<T> = T extends CommandDescriptor
  ? Omit<T, 'mcpExposed'> & {
      mcpExposed?: boolean;
      ownerFiles?: readonly [string, ...string[]];
    }
  : never;
export type RawCommandDescriptor = RawCommandDescriptorShape<CommandDescriptor>;

// ---------------------------------------------------------------------------
// Daemon request-policy trait bundles — copied VERBATIM from
// src/daemon/daemon-command-registry.ts (DAEMON_COMMAND_DESCRIPTORS).
// ---------------------------------------------------------------------------

export const ADMISSION_AND_LOCK_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
} as const;

export const REQUEST_EXECUTION_EXEMPT = {
  leaseAdmissionExempt: true,
  sessionExecutionLockExempt: true,
  selectorValidationExempt: true,
} as const;

export const allowAnyDeviceSessionless = (): boolean => true;

export const isRecordingStartRequest = (req: DispatchedCommand): boolean =>
  (req.positionals?.[0] ?? '').toLowerCase() === 'start';

export const isShardedTestRequest = (req: DispatchedCommand): boolean =>
  req.command === 'test' &&
  (typeof req.flags?.shardAll === 'number' || typeof req.flags?.shardSplit === 'number');

// #2016: a plain `close` (no app-target positional) has nothing to close via
// flags, so it's the only close shape eligible for the sessionless
// no-lease-anywhere admission bypass in request-admission.ts. `close <app>`
// resolves its device straight from flags when there's no session and must
// stay behind full lease/tenant admission.
export const resolvePlainCloseLeaseAdmissionExemption = (
  req: DispatchedCommand,
): { kind: 'unconditional' } | undefined =>
  (req.positionals?.length ?? 0) === 0 ? { kind: 'unconditional' } : undefined;

export const resolveDeferredProviderAppCatalogLeaseAdmissionExemption: NonNullable<
  DaemonCommandDescriptor['sessionlessLeaseAdmissionExemption']
> = (req) => {
  const provider = req.flags?.leaseProvider;
  return req.flags?.leaseId === undefined &&
    typeof provider === 'string' &&
    (req.flags?.platform === 'android' || req.flags?.platform === 'ios')
    ? { kind: 'provider-app-catalog', provider }
    : undefined;
};

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
export const keyboardRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

// alert actions are get/wait/accept/dismiss: get/wait read, accept/dismiss act.
const ALERT_READ_ONLY_ACTIONS = new Set(['get', 'wait']);
export const alertRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  readOnlySubactionRefFrameEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

export const keyboardRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, KEYBOARD_READ_ONLY_ACTIONS, 'status');

export const alertRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, ALERT_READ_ONLY_ACTIONS, 'get');

export const findRecordingEffect = (req: DispatchedCommand): RecordingEffect => {
  try {
    return isReadOnlyFindAction(parseFindArgs(req.positionals ?? []).action)
      ? 'observes-app'
      : 'mutates-app';
  } catch {
    // Invalid requests never record, but classify the unknown shape conservatively.
    return 'mutates-app';
  }
};

export const clipboardRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  readOnlySubactionRecordingEffect(req, new Set(['read']), '');

// A settings request reads only when it names a readable setting with nothing after it; every other
// settings request changes device state — including `settings text-size <category>`, which names the
// same word and performs a mutation. The leg comes from the same resolver the daemon admits with, so
// the classification and the operation it selects are one declaration rather than two that a test
// holds together.
const settingsRequestReads = (req: DispatchedCommand): boolean =>
  resolveSettingsRuntimePlan(req.positionals).kind === 'read';

export const settingsRecordingEffect = (req: DispatchedCommand): RecordingEffect =>
  settingsRequestReads(req) ? 'observes-app' : 'mutates-app';

export const settingsRefFrameEffect = (req: DispatchedCommand): RefFrameEffect =>
  settingsRequestReads(req) ? 'preserve' : 'may-invalidate';

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

export const NO_PLATFORM_EXECUTION = { kind: 'none' } as const;
// Host-scoped platform work (ADR 0019): the descriptor consumes a neutral typed host service and
// binds no device runtime of its own.
export const HOST_PLATFORM_EXECUTION = { kind: 'host' } as const;

/**
 * The daemon/recording traits every generic-route mutating command shares. The legacy execution
 * pair it was split from (`dispatch`/`capability`) is gone: `scroll` was its last consumer, and
 * R53 migrated it, so every generic-route mutating command now spreads this alone.
 */
export const GENERIC_MUTATING_COMMAND_TRAITS = {
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
export const TARGETED_TOUCH_INTERACTION_TRAITS = {
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
export const PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};

// Installs run long device subprocesses; their envelope stays above the longest
// platform install subprocess timeout (see INSTALL_REQUEST_TIMEOUT_MS).
export const INSTALL_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  envelopeMs: INSTALL_REQUEST_TIMEOUT_MS,
};

// Lease-route commands act on billed cloud sessions the daemon owns; resetting
// the daemon on a client timeout would SIGKILL it mid-create/mid-release and
// orphan them all (#1774). Allocation also gets an envelope sized for remote
// device allocation (see LEASE_ALLOCATION_BUDGET_MS).
export const LEASE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};
export const LEASE_ALLOCATE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...LEASE_TIMEOUT_POLICY,
  envelopeMs: LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
};

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

// Settle-capable interaction commands also resolve their target through the
// same platform accessibility capture as snapshot/find (#1105): a hung capture
// is their dominant timeout mode, so on top of the --settle flag-sourced
// widening envelope above, keep the daemon (and sessions) alive on timeout too.
export const SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
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

export const TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM = {
  fields: {
    count: { defaultValue: 1, omitDefault: true },
    intervalMs: { defaultValue: 0, omitDefault: true },
    holdMs: { defaultValue: 0, omitDefault: true },
    jitterPx: { defaultValue: 0, omitDefault: true },
    doubleTap: { defaultValue: false, omitDefault: true },
  },
} as const satisfies CommandResponseDataTransform;

export const FILL_INTERACTION_RESPONSE_DATA_TRANSFORM = {
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
export function postActionObservationTimeoutPolicy(
  command: string,
  withoutObservation: CommandTimeoutPolicy,
): CommandTimeoutPolicy {
  return resolvePostActionObservationSupport(command) !== undefined
    ? SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY
    : withoutObservation;
}

export function postActionObservation(command: string): PostActionObservationSupport {
  const support = resolvePostActionObservationSupport(command);
  if (support === undefined) {
    throw new Error(`Missing post-action observation descriptor support for ${command}`);
  }
  return support;
}

/**
 * Whether this build carries the descriptors' `ownerFiles` claims. Production bundles define
 * `__OWNER_FILES__` as `false`, so every `ownerFilesEnabled ? { ownerFiles: [...] } : {}` spread
 * in the family modules folds to nothing and the navigation paths never reach a bundle — which
 * `pnpm check:bundle-owner-files` proves over `dist/`.
 */
export const ownerFilesEnabled = typeof __OWNER_FILES__ === 'undefined' || __OWNER_FILES__;

export const DEPLOY_APP_COMMAND_DESCRIPTOR = {
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
} as const;

/**
 * Plan-time selectors for the commands whose declared alternatives differ in what they execute.
 * Each reads the daemon step exactly as its handler will (`flags` and `positionals`; a structured
 * `input` only when a caller kept one) and resolves the same plan the handler resolves, for both
 * sides of the active-app split the plan cannot know yet.
 */
export const selectSnapshotStepUses: RuntimeUseStepSelector = (step) => {
  const customActions =
    step.flags?.['snapshotCustomActions'] === true || step.input?.['customActions'] === true;
  return [true, false].map(
    (hasActiveApp) => resolveSnapshotRuntimePlan({ customActions, hasActiveApp }).use,
  );
};

/**
 * `find` parses its action from positionals and defaults a missing one to click, so a step the
 * handler would not parse as a read-only, focus, or type action keeps every declared alternative
 * (fail closed), including a step whose positionals are not there to parse.
 */
export const selectFindStepUses: RuntimeUseStepSelector = (step) => {
  const action = findStepAction(step);
  if (action === undefined || !plansOwnLeg(action)) return findRuntimePlanUses;
  const intent = findRuntimeIntent(action);
  return [true, false].map(
    (hasActiveApp) => resolveSelectorCaptureRuntimePlan({ hasActiveApp, intent }).use,
  );
};

function plansOwnLeg(action: FindAction['kind']): boolean {
  return isReadOnlyFindAction(action) || action === 'focus' || action === 'type';
}

function findStepAction(step: RuntimeUseStep): FindAction['kind'] | undefined {
  if (step.positionals === undefined) return undefined;
  const checked = checkFindArgs(step.positionals, step.flags);
  return checked.ok ? checked.parsed.action : undefined;
}
