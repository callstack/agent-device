import { emitDiagnostic } from '../utils/diagnostics.ts';
import { isApplePlatform, isMobilePlatform } from '@agent-device/kernel/device';
import type { CommandFlags } from '../core/dispatch.ts';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { sleep } from '../utils/timeouts.ts';
import {
  areInteractionSurfaceSignaturesStable,
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  type InteractionSurfaceSignature,
} from './interaction-outcome-policy.ts';
import type { SessionState } from './types.ts';

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

export function markPostGestureStabilization(
  session: SessionState,
  action: string,
  positionals: string[] = [],
  flags?: CommandFlags,
): void {
  if (!supportsPostGestureStabilization(session.device)) return;
  if (!isPostGestureStabilizingAction(action, positionals, flags)) return;
  session.postGestureStabilization = {
    action,
    markedAt: Date.now(),
    // No extra capture: `session.snapshot` is still whatever was captured
    // before this gesture dispatched (this call happens post-dispatch,
    // pre-capture — the same "last known pre-action snapshot" idiom
    // `markPendingInteractionOutcome` already relies on).
    ...(requiresPostGestureBaselineDistrust(session.device)
      ? { baselineSignature: buildInteractionSurfaceSignature(session.snapshot?.nodes ?? []) }
      : {}),
  };
}

function clearPostGestureStabilization(session: SessionState | undefined): void {
  if (!session?.postGestureStabilization) return;
  session.postGestureStabilization = undefined;
}

export type PostGestureStabilityVerdict = 'trust' | 'distrust' | 'accept-stale';

/**
 * Pure decision at the heart of defect 2's fix. Called only once a quiet
 * AX-signature match has already been observed (two consecutive post-gesture
 * polls agree); decides whether that agreement is trustworthy "settled"
 * evidence or a stale-but-consistent AX read that happens to still equal the
 * pre-gesture baseline.
 *
 * - `trust`: accept immediately — the platform doesn't need baseline distrust
 *   (Android is fresh by construction), there is no usable baseline, or the
 *   quiet signature genuinely differs from the pre-gesture baseline (real
 *   movement occurred).
 * - `distrust`: the quiet signature still equals the baseline AND the bounded
 *   distrust cap has not expired — keep polling, do not accept as final.
 * - `accept-stale`: the distrust cap expired and the signature still equals
 *   the baseline. A genuinely inert gesture (e.g. scroll already at an edge)
 *   is the honest read at this point, so it is accepted — but flagged, so a
 *   stale-accept is distinguishable from an ordinary settle in diagnostics.
 *
 * The baseline comparison is `classifyBaselineSurfaceEvidence` — a
 * subset-tolerant, three-valued classifier reusing this codebase's existing
 * `InteractionSurfaceChange` vocabulary (`'changed' | 'unchanged' |
 * 'ambiguous'`), not whole-array equality and not a boolean. Two reasons,
 * both live-verified on #1542 checkout-form.ad before shipping:
 *
 * 1. Scope drift: the pre-gesture baseline and the post-gesture quiet capture
 *    are routinely fetched by different callers with different snapshot
 *    scopes (e.g. a broad text-search capture vs. an interactive-only
 *    selector capture), so their signatures can differ in length/membership
 *    even when the element that matters never moved. Whole-array equality
 *    made the verdict `trust` on the very first quiet match every time,
 *    because the arrays never lined up — never once catching the real
 *    staleness this check exists for.
 * 2. Non-discriminating overlap: a shared-any-entry boolean match is fooled
 *    the opposite way — the viewport root (Application/Window) is always
 *    present and its rect is invariant under any gesture, so a broad
 *    pre-gesture baseline and a narrow post-gesture capture can share ONLY
 *    the root even after a real, successful scroll swapped every actual
 *    element. `classifyBaselineSurfaceEvidence` excludes the root and
 *    keyboard chrome from the overlap it counts as evidence
 *    (`isNonDiscriminatingSurfaceNode`), so that case classifies as
 *    `'ambiguous'` (no comparable evidence) rather than `'unchanged'` (a
 *    match) — `'ambiguous'` falls through to `trust` below, same as `'changed'`.
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

type CapturedSurface<T> = { value: T; signature: InteractionSurfaceSignature };

async function captureInteractionSurface<T>(
  capture: () => Promise<T>,
  readSnapshot: (result: T) => SnapshotState,
  initial?: T,
): Promise<CapturedSurface<T>> {
  const value = initial ?? (await capture());
  return { value, signature: buildInteractionSurfaceSignature(readSnapshot(value).nodes) };
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

export async function capturePostGestureStabilizedResult<T>(params: {
  session: SessionState | undefined;
  capture: () => Promise<T>;
  readSnapshot: (result: T) => SnapshotState;
  initial?: T;
}): Promise<T> {
  const { session, capture, readSnapshot } = params;
  const pending = session?.postGestureStabilization;
  if (!session || !supportsPostGestureStabilization(session.device) || !pending) {
    return params.initial ?? (await capture());
  }

  const needsBaselineDistrust = requiresPostGestureBaselineDistrust(session.device);
  const startedAt = Date.now();
  let attempts = 1;
  let previous = await captureInteractionSurface(capture, readSnapshot, params.initial);
  // Extended past STABILIZATION_DEADLINE_MS only when the distrust verdict
  // fires below; the ordinary (non-distrust) timeout path is unaffected.
  let effectiveDeadlineMs = STABILIZATION_DEADLINE_MS;

  while (attempts < STABILIZATION_MIN_ATTEMPTS || Date.now() - startedAt < effectiveDeadlineMs) {
    await sleep(STABILIZATION_INTERVAL_MS);
    attempts += 1;
    const current = await captureInteractionSurface(capture, readSnapshot);
    if (areInteractionSurfaceSignaturesStable(previous.signature, current.signature)) {
      const elapsedMs = Date.now() - startedAt;
      const verdict = decidePostGestureStabilityVerdict({
        needsBaselineDistrust,
        baselineSignature: pending.baselineSignature,
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
      return current.value;
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
  return previous.value;
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
