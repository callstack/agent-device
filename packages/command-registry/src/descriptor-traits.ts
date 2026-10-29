import type { DispatchedCommand } from '@agent-device/contracts/command';
import { resolvePostActionObservationSupport } from './post-action-observation.ts';
import type { PostActionObservationSupport } from './post-action-observation.ts';
import { DEFAULT_TIMEOUT_POLICY } from './timeout-policy.ts';
import type { CommandDescriptor, CommandResponseDataTransform } from './types.ts';

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
// Daemon request-policy trait bundles — shorthand composed into each
// descriptor's `daemon` facet (ADR 0008, "Daemon ownership"). The daemon
// registry derives its traits from those facets.
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
  compositeResource: 'none',
} as const satisfies Pick<
  Extract<CommandDescriptor, { recordsSessionAction: true }>,
  | 'recordsSessionAction'
  | 'recordingEffect'
  | 'deviceClaimPolicy'
  | 'daemon'
  | 'timeoutPolicy'
  | 'batchable'
  | 'compositeResource'
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

export function postActionObservation(command: string): PostActionObservationSupport {
  const support = resolvePostActionObservationSupport(command);
  if (support === undefined) {
    throw new Error(`Missing post-action observation descriptor support for ${command}`);
  }
  return support;
}

/**
 * Whether this build carries the descriptors' `ownerFiles` claims. Production defines
 * `__OWNER_FILES__` as `false`, so every `ownerFilesEnabled ? { ownerFiles: [...] } : {}` spread
 * in the descriptor modules fold to nothing and the navigation paths never reach a bundle — which
 * `pnpm check:bundle-owner-files` proves over `dist/`.
 */
export const ownerFilesEnabled = typeof __OWNER_FILES__ === 'undefined' || __OWNER_FILES__;
