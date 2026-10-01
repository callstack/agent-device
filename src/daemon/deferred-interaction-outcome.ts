import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { isApplePlatform, isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import {
  captureAndroidFreshnessRecoveredAttempt,
  getActiveAndroidSnapshotFreshness,
  markAndroidSnapshotFreshness,
} from './session-snapshot-freshness.ts';
import {
  isNavigationSensitiveAction,
  type SnapshotFreshnessMode,
} from '@agent-device/capture-kit/snapshot-freshness';
import {
  areInteractionSurfaceSignaturesStable,
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  haveIdenticalDiscriminatingSurfaces,
  summarizeDiscriminatingSurfaceDivergence,
  snapshotSurfaceComparisonKey,
} from './interaction-surface-signature.ts';
import {
  runPostGestureStabilityLoop,
  type PostGestureStabilityOutcome,
} from '@agent-device/capture-kit/post-gesture-stability';
import type { SessionState } from './session-state.ts';

/**
 * The deferred interaction outcome: the daemon's answer to "did that mutation
 * actually take effect?", produced after the mutation's own response has been
 * sent. This module is its one interface — every mutating route marks through
 * `markDeferredInteractionOutcome` right after dispatch, and every snapshot
 * capture resolves through `resolveDeferredInteractionOutcome`. The two
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

/**
 * Mutation-side marking, called once per mutating dispatch after the device op
 * returned. Each marker keeps its own eligibility gate, so callers do not
 * pre-filter — an ineligible action simply marks nothing.
 */
export type DeferredInteractionOutcomeMark = {
  command: string;
  /** Action used for freshness/stabilization eligibility; defaults to `command`. */
  action?: string;
  positionals: string[];
  flags: CommandFlags | undefined;
  androidFreshnessBaseline?: SnapshotState | undefined;
};

export function markDeferredInteractionOutcome(
  params: DeferredInteractionOutcomeMark & { session: SessionState },
): void {
  const {
    session,
    command,
    action = command,
    positionals,
    flags,
    androidFreshnessBaseline,
  } = params;
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
  // No extra capture: `session.snapshot` is still whatever was captured
  // before this gesture dispatched (this call happens post-dispatch,
  // pre-capture — the last known pre-action snapshot). An empty signature is
  // never stored: "no usable baseline" has exactly one
  // representation (absent), so no consumer has to tell `undefined` from `[]`
  // — and the loop cannot rebase a baseline that was never really there.
  const baselineSignature = requiresPostGestureBaselineDistrust(session.device)
    ? buildInteractionSurfaceSignature(session.snapshot?.nodes ?? [])
    : undefined;
  session.postGestureStabilization = {
    action,
    positionals,
    markedAt: Date.now(),
    ...(baselineSignature?.length
      ? {
          baselineSignature,
          // Recorded so the loop can tell a comparable quiet capture from one
          // served by a different backend, which is not comparable at all.
          baselineBackend: snapshotSurfaceComparisonKey(session.snapshot),
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
 * session right now?" — the gate that pauses the Maestro iOS selector route
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
  /** Whether the capture the verdict rides on was interactive-only filtered. */
  interactiveOnly: boolean;
  androidFreshnessMode?: SnapshotFreshnessMode;
  capture: () => Promise<DeferredOutcomeSnapshotAttempt>;
};

export type DeferredOutcomeCaptureResult = {
  snapshot: SnapshotState;
} & SnapshotCaptureAnnotations;

/**
 * Capture-side resolution: when the session carries a deferred outcome, run
 * the capture through the machinery that settles it (post-gesture
 * stabilization, then Android freshness recovery) and
 * return the resolved capture. Returns undefined when nothing is deferred —
 * the caller then captures plainly.
 */
export async function resolveDeferredInteractionOutcome(
  params: DeferredOutcomeCaptureParams,
): Promise<DeferredOutcomeCaptureResult | undefined> {
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

async function capturePostGestureAwareSnapshot(
  params: DeferredOutcomeCaptureParams & { session: SessionState },
): Promise<DeferredOutcomeCaptureResult> {
  const stabilized = await capturePostGestureStabilizedResult({
    session: params.session,
    capture: async () => await capturePostActionSnapshotAttempt(params),
    readSnapshot: (attempt) => attempt.snapshot,
  });
  return resolvedPostGestureCapture(stabilized);
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

/**
 * Session-aware adapter over the pure stability loop
 * (`post-gesture-stability.ts`): reads the pending record, supplies the
 * interaction-surface comparators from interaction-surface-signature as hooks,
 * and — as the R7 owner — clears `postGestureStabilization` once the loop
 * has run, on settle, timeout and an aborted capture alike.
 */
export async function capturePostGestureStabilizedResult<T>(params: {
  session: SessionState | undefined;
  capture: () => Promise<T>;
  readSnapshot: (result: T) => SnapshotState;
  initial?: T;
}): Promise<PostGestureStabilityOutcome<T>> {
  const { session, capture, readSnapshot } = params;
  const pending = session?.postGestureStabilization;
  if (!session || !supportsPostGestureStabilization(session.device) || !pending) {
    return { value: params.initial ?? (await capture()) };
  }

  // Entering the loop consumes the record. It is cleared on every exit: a settled surface, the
  // stabilization timeout, or a capture that threw. A later capture on the session never pays this
  // gesture's loop again.
  try {
    return await runPostGestureStabilityLoop({
      pending: {
        action: pending.action,
        positionals: pending.positionals ?? [],
        baselineSignature: pending.baselineSignature,
        baselineBackend: pending.baselineBackend,
      },
      needsBaselineDistrust: requiresPostGestureBaselineDistrust(session.device),
      initial: params.initial,
      hooks: {
        capture,
        readSurface: (value) => {
          const snapshot = readSnapshot(value);
          return {
            signature: buildInteractionSurfaceSignature(snapshot.nodes),
            backend: snapshotSurfaceComparisonKey(snapshot),
          };
        },
        signaturesStable: areInteractionSurfaceSignaturesStable,
        classifyBaselineEvidence: classifyBaselineSurfaceEvidence,
        surfacesIdentical: haveIdenticalDiscriminatingSurfaces,
        summarizeDivergence: summarizeDiscriminatingSurfaceDivergence,
      },
    });
  } finally {
    clearPostGestureStabilization(session);
  }
}

/** The stabilized attempt as a capture result: the tree carries the gesture's outcome as its own fact. */
function resolvedPostGestureCapture(
  stabilized: PostGestureStabilityOutcome<DeferredOutcomeSnapshotAttempt>,
): DeferredOutcomeCaptureResult {
  const { snapshot, annotations } = stabilized.value;
  if (stabilized.postGestureOutcome) snapshot.postGestureOutcome = stabilized.postGestureOutcome;
  return { snapshot, ...annotations };
}

export function stripInternalInteractionFlags(
  flags: CommandFlags | undefined,
): CommandFlags | undefined {
  if (!flags?.postGestureStabilization) return flags;
  const { postGestureStabilization: _postGestureStabilization, ...publicFlags } = flags;
  return publicFlags;
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
