import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation, SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import type { PostOpenObservation } from '@agent-device/contracts/application-lifecycle-runtime';
import type { SnapshotCaptureAnnotations } from '@agent-device/contracts/capture';
import { isApplePlatform, isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { MovingTargetBaseline } from '@agent-device/contracts/moving-target-gate';
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
import type { DeferredSurface, SessionState } from './session-state.ts';

/**
 * The deferred interaction outcome: the daemon's answer to "did that mutation
 * actually take effect?", produced after the mutation's own response has been
 * sent. This module is its one interface — every mutating route marks through
 * `markDeferredInteractionOutcome` right after dispatch (an app open also marks
 * `markPostOpenStabilization` once its session is published), and every snapshot
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
  /**
   * The tree this mutation resolved its target against, when it resolved one (#3471). Feeds the
   * moving-target baseline; absent for the routes that dispatch without a daemon tree.
   */
  preActionTree?: SurfaceScopedNodes | undefined;
  /**
   * The action's own `--settle` observation, when it ran one (#3471). Its `diff` is the load-bearing
   * field: the runtime attaches it only when the loop converged AND stored its settled tree within
   * one surface, which is exactly when that published tree may stand as the baseline.
   */
  settle?: SettleObservation | undefined;
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
    preActionTree,
    settle,
  } = params;
  if (isNavigationSensitiveAction(action)) {
    markAndroidSnapshotFreshness(session, action, androidFreshnessBaseline ?? session.snapshot);
  }
  // The two post-action mechanisms are complementary, and this is the seam that keeps them apart.
  // A gesture-shaped mutation hands its unsettled surface to the capture side: every following
  // capture runs the quiet-window loop before it returns a tree, so the moving-target gate would
  // only re-do that wait. A mutation that marks no stabilization — the press whose own effect was
  // an animation — is the case nothing else watches, and is exactly what the gate is for. It also
  // never displaces a stabilization some earlier mutation still owes: an `@ref` press spends no
  // capture, so a scroll's owed loop can still be pending here, and erasing it would drop the
  // #1542/#1600 unsettled-tree check the scroll bought.
  if (markSurfaceStabilization(session, action, positionals, flags)) return;
  if (pendingSurfaceStabilization(session)) return;
  markMovingTargetBaseline(session, preActionTree, settle?.diff !== undefined);
}

/** Narrows a published capture to the shape a baseline keeps, so a stored tree never smuggles in more. */
function movingTargetRestTree(snapshot: SnapshotState | undefined): SurfaceScopedNodes | undefined {
  if (!snapshot) return undefined;
  return {
    nodes: snapshot.nodes,
    ...(snapshot.iosSystemSurfaceBundleId
      ? { surfaceBundleId: snapshot.iosSystemSurfaceBundleId }
      : {}),
  };
}

/** Whether this mutation left an unsettled surface for the capture side to steady. */
function markSurfaceStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): boolean {
  if (!supportsPostGestureStabilization(session.device)) return false;
  if (!isPostGestureStabilizingAction(action, positionals, flags)) return false;
  // No extra capture: `session.snapshot` is still whatever was captured
  // before this gesture dispatched (this call happens post-dispatch,
  // pre-capture — the last known pre-action snapshot). An empty signature is
  // never stored: "no usable baseline" has exactly one
  // representation (absent), so no consumer has to tell `undefined` from `[]`
  // — and the loop cannot rebase a baseline that was never really there.
  const baselineSignature = requiresPostGestureBaselineDistrust(session.device)
    ? buildInteractionSurfaceSignature(session.snapshot?.nodes ?? [])
    : undefined;
  session.deferredSurface = {
    kind: 'stabilize',
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
  return true;
}

/**
 * Records the tree a finished mutation acted through, stamped at the instant it finished (#3471) —
 * the `recheck` variant of the session's deferred surface, for the mutation that marks no
 * stabilization: the press whose own effect was an animation, which nothing else watches.
 *
 * `preActionTree` is the observation the action resolved its target against, and is required: a
 * mutation that resolved nothing has no tree to describe where things were, and substituting an
 * older snapshot would attribute to this action a surface it never looked at. A tree that names no
 * nodes records nothing either, for the same reason — an empty tree would make every later target
 * read as newly arrived, which is a claim about motion no action here ever observed. That is also
 * why the routes that dispatch with no tree of their own leave the session idle: a raw coordinate
 * unless `--verify`/`--settle` made it capture one, a Maestro direct-selector tap, `back`, an app
 * open. The ordinary navigate-then-tap step pays the gate nothing.
 *
 * `restProved` switches the tree to the session's published one, and is set only when the action's
 * own settle loop converged AND stored its settled tree. Everything else keeps the pre-action tree,
 * a timed-out loop included: the session's snapshot may hold a freshness capture, a `@ref` press's
 * authorized frame, a lone `--verify` capture, or the newest read of a surface that never quieted,
 * and none of those proves rest. Preferring it because it merely differs from the tree the action
 * resolved against is the same forbidden substitution, from the other side.
 */
function markMovingTargetBaseline(
  session: SessionState,
  preActionTree: SurfaceScopedNodes | undefined,
  restProved: boolean,
): void {
  const tree = restProved ? movingTargetRestTree(session.snapshot) : preActionTree;
  if (!tree || tree.nodes.length === 0) {
    retireMovingTargetBaseline(session);
    return;
  }
  session.deferredSurface = {
    kind: 'recheck',
    baseline: { finishedAt: Date.now(), tree },
  };
}

/**
 * Retires the `recheck` variant only, from ADR 0014's device side-effect seam. A gate out of evidence
 * goes idle rather than reconstructing a baseline from another source. A pending stabilization is
 * left alone: the seam fires on the way INTO every device op, including the gesture that just marked
 * one, and the capture side still owes that loop.
 */
export function retireMovingTargetBaseline(session: SessionState): void {
  if (session.deferredSurface?.kind !== 'recheck') return;
  session.deferredSurface = undefined;
}

/**
 * The baseline the #3471 gate screens a freshly resolved rect against, or nothing when the session
 * is idle or owes the capture-side loop instead. The tree is carried to the command layer because
 * the gate judges a new rect against the tree the PREVIOUS action acted through — the `snapshot`
 * beside it is the newest observation, which is the one thing that cannot show a target having
 * moved.
 */
export function movingTargetBaseline(
  session: SessionState | undefined,
): MovingTargetBaseline | undefined {
  return session?.deferredSurface?.kind === 'recheck'
    ? session.deferredSurface.baseline
    : undefined;
}

/**
 * Called once an app open has published its session. A verdict other than `observable` means the
 * open never read the launched app: the probe failed or could not identify it, the device has no
 * observation path, or the app stayed unreadable. Nothing proved its layout at rest, so the next
 * capture runs the quiet-window loop (#3354, #3367). An open that reports no verdict does not mark.
 * No baseline: the pre-open tree is a different surface, so the open is never reported as having no
 * effect.
 */
export function markPostOpenStabilization(
  session: SessionState,
  observation: PostOpenObservation | undefined,
): void {
  if (!isApplePlatform(session.device.platform)) return;
  if (!supportsPostGestureStabilization(session.device)) return;
  if (observation === undefined || observation === 'observable') return;
  session.deferredSurface = {
    kind: 'stabilize',
    action: 'open',
    positionals: [],
    markedAt: Date.now(),
  };
}

function clearSurfaceStabilization(session: SessionState | undefined): void {
  if (session?.deferredSurface?.kind !== 'stabilize') return;
  session.deferredSurface = undefined;
}

/**
 * The one read of the pending capture-side stabilization. The boolean below is what callers outside
 * this module ask; this is the record itself, for the loop that has to run it and for the tests that
 * pin what a marker stored. Nothing else narrows the variant.
 */
export function pendingSurfaceStabilization(
  session: SessionState | undefined,
): Extract<DeferredSurface, { kind: 'stabilize' }> | undefined {
  return session?.deferredSurface?.kind === 'stabilize' ? session.deferredSurface : undefined;
}

/**
 * The one read other modules are allowed: "is a stabilization pending on this
 * session right now?" — the gate that pauses the Maestro iOS selector route
 * and the selector snapshot cache while the tree may still be moving. Callers
 * never see the field shape; what a pending record contains is this module's
 * implementation.
 */
export function isPostGestureStabilizationPending(session: SessionState | undefined): boolean {
  return pendingSurfaceStabilization(session) !== undefined;
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
  const pending = pendingSurfaceStabilization(session);
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
    clearSurfaceStabilization(session);
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
