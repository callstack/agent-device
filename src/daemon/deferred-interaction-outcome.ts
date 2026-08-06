import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { isApplePlatform, isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { CommandFlags } from '../core/dispatch.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { sleep } from '../utils/timeouts.ts';
import {
  captureAndroidFreshnessRecoveredAttempt,
  clearAndroidSnapshotFreshness,
  getActiveAndroidSnapshotFreshness,
  isNavigationSensitiveAction,
  markAndroidSnapshotFreshness,
  type AndroidFreshnessMode,
} from './android-snapshot-freshness.ts';
import { withGestureNoEffectWarning } from './gesture-no-effect.ts';
import {
  areInteractionSurfaceSignaturesStable,
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  classifyInteractionSurfaceChange,
  clearPendingInteractionOutcome,
  emitInteractionSettled,
  emitInteractionSettleTimeout,
  getActivePendingInteractionOutcome,
  haveIdenticalDiscriminatingSurfaces,
  markPendingInteractionOutcome,
  retryPendingInteractionOutcome,
  type InteractionSurfaceSignature,
} from './interaction-outcome-policy.ts';
import type { SessionState } from './types.ts';

/**
 * The deferred interaction outcome: the daemon's answer to "did that mutation
 * actually take effect?", produced after the mutation's own response has been
 * sent. This module is its one interface — every mutating route marks through
 * `markDeferredInteractionOutcome` right after dispatch, and every snapshot
 * capture resolves through `resolveDeferredInteractionOutcome`. The three
 * SessionState fields stay with their owner modules; this module is itself the
 * `postGestureStabilization` owner (R7), so hosting the interface here adds no
 * new node to the R9 type cycle — the seam lives in a node that was already on
 * the member-to-member paths it now concentrates.
 *
 * Distinct from the opt-in same-response settled observation
 * (`--settle`/`--verify`, `src/commands/interaction/runtime/settle.ts`), and
 * deliberately scoped to these post-action markers only: ADR 0014's ref-frame
 * expiry and ADR 0012/0016's staged repair protocol are different consistency
 * disciplines and never route through here.
 */

const INTERACTION_CHANGE_RECHECK_DELAY_MS = 500;
const STABILIZATION_DEADLINE_MS = 1_500;
const STABILIZATION_INTERVAL_MS = 200;
const STABILIZATION_MIN_ATTEMPTS = 2;

/**
 * Defect 2 (#1542): a bounded extra budget used ONLY when a quiet AX-signature
 * match (two consecutive polls agree) still equals the pre-gesture baseline on
 * the Apple synthesized-gesture lane (see `requiresPostGestureBaselineDistrust`).
 * XCTest's AX tree isn't proactively resynced by a synthesized touch, so it
 * can serve a stale-but-internally-consistent read that two polls agree on
 * without the screen having moved.
 *
 * 2s of real margin over both the poll interval (200ms) and the normal
 * deadline (1.5s) — a near-zero margin between a poll interval and a quiet
 * window is a proven flake source in this codebase (see
 * settle-zero-margin-flake, a week-long contention-flake root cause), so this
 * cap is sized to never come close to that trap.
 */
const STABILIZATION_DISTRUST_DEADLINE_MS = STABILIZATION_DEADLINE_MS + 2_000;

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

function markPostGestureStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): void {
  if (!supportsPostGestureStabilization(session.device)) return;
  if (!isPostGestureStabilizingAction(action, positionals, flags)) return;
  session.postGestureStabilization = {
    action,
    positionals,
    markedAt: Date.now(),
    // No extra capture: `session.snapshot` is still whatever was captured
    // before this gesture dispatched (this call happens post-dispatch,
    // pre-capture — the same "last known pre-action snapshot" idiom
    // `markPendingInteractionOutcome` already relies on).
    ...(requiresPostGestureBaselineDistrust(session.device)
      ? {
          baselineSignature: buildInteractionSurfaceSignature(session.snapshot?.nodes ?? []),
          // Recorded so the loop can tell a comparable quiet capture from one
          // served by a different backend, which is not comparable at all.
          baselineBackend: session.snapshot?.snapshotQuality?.backend,
        }
      : {}),
  };
}

function clearPostGestureStabilization(session: SessionState | undefined): void {
  if (!session?.postGestureStabilization) return;
  session.postGestureStabilization = undefined;
}

/**
 * The one read other modules are allowed: "is a stabilization pending on this
 * session right now?" — the gate that pauses the direct iOS selector fast path
 * and the selector snapshot cache while the tree may still be moving. Callers
 * never see the field shape; what a pending record contains is this module's
 * implementation.
 */
export function isPostGestureStabilizationPending(session: SessionState | undefined): boolean {
  return Boolean(session?.postGestureStabilization);
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
    const latest = await captureAndroidFreshnessRecoveredAttempt(params, freshness);
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

async function capturePostActionSnapshotAttempt(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
): Promise<DeferredOutcomeSnapshotAttempt> {
  const freshness = getActiveAndroidSnapshotFreshness(params.session);
  if (freshness && params.device.platform === 'android') {
    return await captureAndroidFreshnessRecoveredAttempt(params, freshness);
  }
  return await params.capture();
}

export type PostGestureStabilityVerdict = 'trust' | 'distrust' | 'accept-stale';

/**
 * Pure decision at the heart of defect 2's fix (#1542). Called only once a
 * quiet AX-signature match has already been observed (two consecutive
 * post-gesture polls agree); decides whether that agreement is trustworthy
 * "settled" evidence or a stale-but-consistent AX read that happens to still
 * equal the pre-gesture baseline.
 *
 * - `trust`: accept immediately — the platform doesn't need baseline distrust
 *   (Android is fresh by construction), there is no usable baseline, or the
 *   quiet signature genuinely differs from the pre-gesture baseline.
 * - `distrust`: the quiet signature still equals the baseline AND the bounded
 *   distrust cap has not expired — keep polling, do not accept as final.
 * - `accept-stale`: the cap expired and the signature still equals the
 *   baseline. A genuinely inert gesture (e.g. scroll already at an edge) is
 *   the honest read at this point, so it is accepted — but flagged, so a
 *   stale-accept is distinguishable from an ordinary settle in diagnostics.
 *
 * The baseline comparison is `classifyBaselineSurfaceEvidence` — see its doc
 * for why it is subset-tolerant set membership over identified content, not
 * whole-array equality and not a boolean (#1542/#1569, both live-verified).
 * `'ambiguous'` (no comparable evidence) falls through to `trust`, same as
 * `'changed'`.
 */
export function decidePostGestureStabilityVerdict(params: {
  needsBaselineDistrust: boolean;
  baselineSignature: InteractionSurfaceSignature | undefined;
  quietSignature: InteractionSurfaceSignature;
  elapsedMs: number;
  distrustCapMs: number;
}): PostGestureStabilityVerdict {
  const { needsBaselineDistrust, baselineSignature, quietSignature, elapsedMs, distrustCapMs } =
    params;
  if (!needsBaselineDistrust || !baselineSignature?.length) return 'trust';
  if (classifyBaselineSurfaceEvidence(baselineSignature, quietSignature) !== 'unchanged') {
    return 'trust';
  }
  return elapsedMs < distrustCapMs ? 'distrust' : 'accept-stale';
}

type CapturedSurface<T> = {
  value: T;
  signature: InteractionSurfaceSignature;
  backend: string | undefined;
};

async function captureInteractionSurface<T>(
  capture: () => Promise<T>,
  readSnapshot: (result: T) => SnapshotState,
  initial?: T,
): Promise<CapturedSurface<T>> {
  const value = initial ?? (await capture());
  const snapshot = readSnapshot(value);
  return {
    value,
    signature: buildInteractionSurfaceSignature(snapshot.nodes),
    backend: snapshot.snapshotQuality?.backend,
  };
}

function emitPostGestureSettleDiagnostic(
  verdict: 'trust' | 'accept-stale',
  action: string,
  attempts: number,
  durationMs: number,
): void {
  if (verdict === 'accept-stale') {
    emitDiagnostic({
      level: 'warn',
      phase: 'post_gesture_snapshot_stale_accept',
      data: { action, attempts, durationMs, matchedPreGestureBaseline: true },
    });
    return;
  }
  emitDiagnostic({
    level: attempts > 2 ? 'info' : 'debug',
    phase: 'post_gesture_snapshot_stabilized',
    data: { action, attempts, durationMs },
  });
}

export type PostGestureStabilizedResult<T> = {
  value: T;
  /**
   * Present ONLY when the accept-stale verdict is corroborated by full-surface
   * evidence: every discriminating entry of the quiet capture matches the
   * pre-gesture baseline exactly, in both directions
   * (`haveIdenticalDiscriminatingSurfaces`). The bare verdict is NOT enough —
   * it is subset-tolerant by design, and a successful scroll that replaced
   * every list cell under fixed chrome still reads accept-stale (#1601 review
   * P1). Callers surface this to the agent: a diagnostics-only signal let one
   * benchmark run burn 40 calls re-issuing scrolls that moved nothing (#1600).
   */
  gestureNoEffect?: { action: string; positionals: string[] };
};

export async function capturePostGestureStabilizedResult<T>(params: {
  session: SessionState | undefined;
  capture: () => Promise<T>;
  readSnapshot: (result: T) => SnapshotState;
  initial?: T;
}): Promise<PostGestureStabilizedResult<T>> {
  const { session, capture, readSnapshot } = params;
  const pending = session?.postGestureStabilization;
  if (!session || !supportsPostGestureStabilization(session.device) || !pending) {
    return { value: params.initial ?? (await capture()) };
  }

  const needsBaselineDistrust = requiresPostGestureBaselineDistrust(session.device);
  const startedAt = Date.now();
  let attempts = 1;
  let previous = await captureInteractionSurface(capture, readSnapshot, params.initial);
  let baselineSignature = pending.baselineSignature;
  let baselineBackend = pending.baselineBackend;
  // Extended past STABILIZATION_DEADLINE_MS only when the distrust verdict
  // fires below; the ordinary (non-distrust) timeout path is unaffected.
  let effectiveDeadlineMs = STABILIZATION_DEADLINE_MS;

  while (attempts < STABILIZATION_MIN_ATTEMPTS || Date.now() - startedAt < effectiveDeadlineMs) {
    await sleep(STABILIZATION_INTERVAL_MS);
    attempts += 1;
    const current = await captureInteractionSurface(capture, readSnapshot);
    if (areInteractionSurfaceSignaturesStable(previous.signature, current.signature)) {
      const elapsedMs = Date.now() - startedAt;
      // A capture plan may fall back or be pre-empted by the XCTest-channel
      // penalty at any time, so the backend can change mid-poll. Backends do
      // not agree on which nodes exist, so this pair says nothing about the
      // gesture: adopt it as the baseline and keep going rather than concluding
      // from it (#1569).
      if (baselineSignature && baselineBackend !== current.backend) {
        emitDiagnostic({
          level: 'debug',
          phase: 'post_gesture_snapshot_baseline_rebased',
          data: { action: pending.action, from: baselineBackend, to: current.backend, attempts },
        });
        baselineSignature = current.signature;
        baselineBackend = current.backend;
        previous = current;
        continue;
      }
      const verdict = decidePostGestureStabilityVerdict({
        needsBaselineDistrust,
        baselineSignature,
        quietSignature: current.signature,
        elapsedMs,
        distrustCapMs: STABILIZATION_DISTRUST_DEADLINE_MS,
      });
      if (verdict === 'distrust') {
        effectiveDeadlineMs = STABILIZATION_DISTRUST_DEADLINE_MS;
        previous = current;
        continue;
      }
      clearPostGestureStabilization(session);
      emitPostGestureSettleDiagnostic(verdict, pending.action, attempts, elapsedMs);
      return buildAcceptedStabilizedResult(verdict, pending, current);
    }
    previous = current;
  }

  clearPostGestureStabilization(session);
  emitDiagnostic({
    level: 'warn',
    phase: 'post_gesture_snapshot_stabilization_timeout',
    data: {
      action: pending.action,
      attempts,
      durationMs: Date.now() - startedAt,
    },
  });
  return { value: previous.value };
}

/**
 * The no-effect claim needs BOTH the accept-stale verdict AND full-surface
 * corroboration (`haveIdenticalDiscriminatingSurfaces`): the verdict alone is
 * subset-tolerant, and a successful scroll that replaced every list cell
 * under fixed chrome still reads accept-stale (#1601 review P1).
 */
function buildAcceptedStabilizedResult<T>(
  verdict: 'trust' | 'accept-stale',
  pending: NonNullable<SessionState['postGestureStabilization']>,
  current: CapturedSurface<T>,
): PostGestureStabilizedResult<T> {
  const corroborated =
    verdict === 'accept-stale' &&
    haveIdenticalDiscriminatingSurfaces(pending.baselineSignature ?? [], current.signature);
  if (!corroborated) return { value: current.value };
  return {
    value: current.value,
    gestureNoEffect: {
      action: pending.action,
      positionals: pending.positionals ?? [],
    },
  };
}

function isPostGestureStabilizingAction(
  action: string,
  positionals: string[],
  flags: CommandFlags | undefined,
): boolean {
  if (flags?.postGestureStabilization === false) return false;
  if (flags?.postGestureStabilization === true) return true;
  if (action === 'swipe' || action === 'scroll') return true;
  return action === 'gesture' && positionals[0] === 'swipe';
}

function supportsPostGestureStabilization(device: SessionState['device']): boolean {
  return isMobilePlatform(device);
}

/**
 * Apple-only gate for defect 2's baseline-distrust check (#1542). Android's
 * persistent helper clears its accessibility-node cache before every capture
 * (`AccessibilityTreeCapture.capture` →  `clearAccessibilityCache`,
 * #1254/#1259), so an Android post-gesture read is fresh by construction and
 * cannot reproduce the stale-but-internally-consistent AX tree this check
 * exists to catch. Gating here keeps Android's stabilization latency and
 * semantics untouched — this only ever adds cost on the Apple lane.
 */
function requiresPostGestureBaselineDistrust(device: SessionState['device']): boolean {
  return isApplePlatform(device.platform);
}
