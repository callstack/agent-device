import {
  snapshotCaptureAnnotationsFrom,
  type SnapshotCaptureAnnotations,
} from '@agent-device/contracts/capture';
import { isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { CommandFlags } from '../core/dispatch.ts';
import { sleep } from '../utils/timeouts.ts';
import {
  ANDROID_FRESHNESS_RETRY_DEADLINE_MS,
  ANDROID_FRESHNESS_RETRY_DELAYS_MS,
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  getAndroidFreshnessReason,
  isNavigationSensitiveAction,
  markAndroidSnapshotFreshness,
  type AndroidFreshnessMode,
} from './android-snapshot-freshness.ts';
import {
  buildInteractionSurfaceSignature,
  classifyInteractionSurfaceChange,
  clearPendingInteractionOutcome,
  emitInteractionSettled,
  emitInteractionSettleTimeout,
  getActivePendingInteractionOutcome,
  markPendingInteractionOutcome,
  retryPendingInteractionOutcome,
} from './interaction-outcome-policy.ts';
import {
  capturePostGestureStabilizedResult,
  formatGestureNoEffectWarning,
  isPostGestureStabilizationPending,
  markPostGestureStabilization,
} from './post-gesture-stabilization.ts';
import type { SessionState } from './types.ts';

/**
 * The deferred interaction outcome: the daemon's answer to "did that mutation
 * actually take effect?", produced after the mutation's own response has been
 * sent. This module is its one interface — every mutating route marks through
 * `markDeferredInteractionOutcome` right after dispatch, and every snapshot
 * capture resolves through `resolveDeferredInteractionOutcome`. The three
 * SessionState fields (`pendingInteractionOutcome`, `postGestureStabilization`,
 * `androidSnapshotFreshness`) and their owner modules are implementation.
 *
 * Distinct from the opt-in same-response settled observation
 * (`--settle`/`--verify`, `src/commands/interaction/runtime/settle.ts`), and
 * deliberately scoped to these post-action markers only: ADR 0014's ref-frame
 * expiry and ADR 0012/0016's staged repair protocol are different consistency
 * disciplines and never route through here.
 */

const INTERACTION_CHANGE_RECHECK_DELAY_MS = 500;

/**
 * Mutation-side marking, called once per mutating dispatch after the device op
 * returned. Ordering across the markers is load-bearing (Selector Capture
 * Reliability Contract: pending interaction outcome retry runs before
 * post-gesture stabilization) and each marker keeps its own eligibility gate,
 * so callers do not pre-filter — an ineligible action simply marks nothing.
 */
export function markDeferredInteractionOutcome(params: {
  session: SessionState;
  command: string;
  /** Action used for freshness/stabilization eligibility; defaults to `command`. */
  action?: string;
  positionals: string[];
  flags: CommandFlags | undefined;
  /** True only when no post-action observation already proved the interaction landed. */
  scheduleOutcomeRetry?: boolean;
  androidFreshnessBaseline?: SnapshotState | undefined;
}): void {
  const {
    session,
    command,
    action = command,
    positionals,
    flags,
    scheduleOutcomeRetry = false,
    androidFreshnessBaseline,
  } = params;
  if (scheduleOutcomeRetry) {
    markPendingInteractionOutcome({
      session,
      command,
      positionals,
      flags,
      preSnapshot: session.snapshot,
    });
  }
  if (isNavigationSensitiveAction(action)) {
    markAndroidSnapshotFreshness(session, action, androidFreshnessBaseline ?? session.snapshot);
  }
  markPostGestureStabilization(session, action, positionals, flags);
}

export type DeferredOutcomeSnapshotAttempt = {
  snapshot: SnapshotState;
  annotations: SnapshotCaptureAnnotations;
};

type DeferredOutcomeCaptureParams = {
  session: SessionState | undefined;
  device: SessionState['device'];
  logPath: string;
  /** Whether the capture the verdict rides on was interactive-only filtered. */
  interactiveOnly: boolean;
  androidFreshnessMode?: AndroidFreshnessMode;
  capture: () => Promise<DeferredOutcomeSnapshotAttempt>;
};

export type DeferredOutcomeCaptureResult = {
  snapshot: SnapshotState;
} & SnapshotCaptureAnnotations;

/**
 * Capture-side resolution: when the session carries a deferred outcome, run
 * the capture through the machinery that settles it (pending-outcome retry,
 * then post-gesture stabilization, then Android freshness recovery) and
 * return the resolved capture. Returns undefined when nothing is deferred —
 * the caller then captures plainly.
 */
export async function resolveDeferredInteractionOutcome(
  params: DeferredOutcomeCaptureParams,
): Promise<DeferredOutcomeCaptureResult | undefined> {
  const pendingInteractionOutcome = getActivePendingInteractionOutcome(params.session);
  if (pendingInteractionOutcome && params.session) {
    return await captureInteractionOutcomeAwareSnapshot(
      { ...params, session: params.session },
      pendingInteractionOutcome,
    );
  }
  if (
    isMobilePlatform(params.device) &&
    params.session &&
    isPostGestureStabilizationPending(params.session)
  ) {
    return await capturePostGestureAwareSnapshot({ ...params, session: params.session });
  }
  const freshness = getActiveAndroidSnapshotFreshness(params.session);
  if (freshness && params.device.platform === 'android') {
    const latest = await captureAndroidFreshnessAwareAttempt(params, freshness);
    return {
      snapshot: latest.snapshot,
      ...latest.annotations,
    };
  }
  return undefined;
}

async function captureInteractionOutcomeAwareSnapshot(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
  pending: NonNullable<SessionState['pendingInteractionOutcome']>,
): Promise<DeferredOutcomeCaptureResult> {
  const session = params.session;

  const startedAt = Date.now();
  let retryAttempts = 0;
  let latest = await waitForDelayedInteractionSurfaceChange(
    params,
    pending,
    await capturePostActionSnapshotAttempt(params),
  );
  let outcome = await retryPendingInteractionOutcome({
    session,
    pending,
    logPath: params.logPath,
    snapshot: latest.snapshot,
  });

  while (outcome.retried) {
    retryAttempts += 1;
    latest = await waitForDelayedInteractionSurfaceChange(
      params,
      pending,
      await capturePostActionSnapshotAttempt(params),
    );
    outcome = await retryPendingInteractionOutcome({
      session,
      pending,
      logPath: params.logPath,
      snapshot: latest.snapshot,
    });
  }

  clearPendingInteractionOutcome(session);
  const stabilized = await capturePostGestureStabilizedResult({
    session,
    initial: latest,
    capture: async () => await capturePostActionSnapshotAttempt(params),
    readSnapshot: (attempt) => attempt.snapshot,
  });
  latest = stabilized.value;
  if (outcome.change !== 'ambiguous' && latest.annotations.freshness?.staleAfterRetries !== true) {
    clearAndroidSnapshotFreshness(session);
  }
  if (outcome.change === 'unchanged') {
    emitInteractionSettleTimeout({ pending, attempts: retryAttempts, startedAt });
  } else {
    emitInteractionSettled({
      pending,
      change: outcome.change,
      attempts: retryAttempts,
      startedAt,
    });
  }

  return {
    snapshot: latest.snapshot,
    ...withGestureNoEffectWarning(latest.annotations, stabilized.gestureNoEffect),
  };
}

async function waitForDelayedInteractionSurfaceChange(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
  pending: NonNullable<SessionState['pendingInteractionOutcome']>,
  initial: DeferredOutcomeSnapshotAttempt,
): Promise<DeferredOutcomeSnapshotAttempt> {
  let latest = initial;
  const change = classifyInteractionSurfaceChange(
    pending.preSignature,
    buildInteractionSurfaceSignature(latest.snapshot.nodes),
  );
  if (change !== 'unchanged') return latest;

  await sleep(INTERACTION_CHANGE_RECHECK_DELAY_MS);
  latest = await capturePostActionSnapshotAttempt(params);

  return latest;
}

async function captureAndroidFreshnessAwareAttempt(
  params: DeferredOutcomeCaptureParams,
  freshness: NonNullable<SessionState['androidSnapshotFreshness']>,
): Promise<DeferredOutcomeSnapshotAttempt> {
  let latest = await params.capture();
  let suspiciousReason = classifyAttemptFreshness(latest, freshness, params);
  let retryCount = 0;
  const retryUntilMs = freshness.markedAt + ANDROID_FRESHNESS_RETRY_DEADLINE_MS;

  for (const delayMs of ANDROID_FRESHNESS_RETRY_DELAYS_MS) {
    if (!suspiciousReason) break;
    const remainingMs = retryUntilMs - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(delayMs, remainingMs));
    latest = await params.capture();
    retryCount += 1;
    suspiciousReason = classifyAttemptFreshness(latest, freshness, params);
  }

  if (!suspiciousReason) {
    clearAndroidSnapshotFreshness(params.session);
  }

  const freshnessAnnotation =
    retryCount > 0 || Boolean(suspiciousReason)
      ? {
          action: freshness.action,
          retryCount,
          staleAfterRetries: Boolean(suspiciousReason),
          reason: suspiciousReason ?? undefined,
        }
      : undefined;
  return {
    ...latest,
    annotations: {
      ...latest.annotations,
      ...snapshotCaptureAnnotationsFrom({ freshness: freshnessAnnotation }),
    },
  };
}

function classifyAttemptFreshness(
  attempt: DeferredOutcomeSnapshotAttempt,
  freshness: NonNullable<SessionState['androidSnapshotFreshness']>,
  params: Pick<DeferredOutcomeCaptureParams, 'interactiveOnly' | 'androidFreshnessMode'>,
) {
  return getAndroidFreshnessReason(
    { snapshot: attempt.snapshot, rawNodeCount: attempt.annotations.analysis?.rawNodeCount },
    freshness,
    { interactiveOnly: params.interactiveOnly, mode: params.androidFreshnessMode },
  );
}

async function capturePostGestureAwareSnapshot(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
): Promise<DeferredOutcomeCaptureResult> {
  const stabilized = await capturePostGestureStabilizedResult({
    session: params.session,
    capture: async () => await capturePostActionSnapshotAttempt(params),
    readSnapshot: (attempt) => attempt.snapshot,
  });
  const latest = stabilized.value;
  return {
    snapshot: latest.snapshot,
    ...withGestureNoEffectWarning(latest.annotations, stabilized.gestureNoEffect),
  };
}

/**
 * #1600: a proven no-effect gesture must reach the agent inside the very
 * response it reads next, not only the diagnostics stream. Warnings ride the
 * existing annotations channel so every renderer that already prints capture
 * warnings picks this up with no new plumbing.
 */
function withGestureNoEffectWarning(
  annotations: SnapshotCaptureAnnotations,
  gestureNoEffect: { action: string; positionals: string[] } | undefined,
): SnapshotCaptureAnnotations {
  if (!gestureNoEffect) return annotations;
  return {
    ...annotations,
    warnings: [
      ...(annotations.warnings ?? []),
      formatGestureNoEffectWarning(gestureNoEffect.action, gestureNoEffect.positionals),
    ],
  };
}

async function capturePostActionSnapshotAttempt(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
): Promise<DeferredOutcomeSnapshotAttempt> {
  const freshness = getActiveAndroidSnapshotFreshness(params.session);
  if (freshness && params.device.platform === 'android') {
    return await captureAndroidFreshnessAwareAttempt(params, freshness);
  }
  return await params.capture();
}
