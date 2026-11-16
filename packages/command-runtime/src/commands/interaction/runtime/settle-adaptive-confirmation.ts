import { isBusyIndicatorNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
import { withoutSettleChrome } from '@agent-device/capture-kit/snapshot-chrome';
import {
  sharedIdentityCount,
  stableCaptureSignal,
  stableCaptureSignalsEqual,
  type StableCaptureSignal,
} from './stable-capture-signal.ts';

/**
 * Internal prototype (`SettleParams.earlyExit: 'adaptive'`): a capture that differs from a fresh
 * pre-action baseline, and that one short confirmation capture agrees with, settles before the
 * quiet window. Every other case keeps the quiet window: no capture has differed yet (a no-op, a
 * toggle that has not rendered, a late effect), the confirmation disagrees, a busy indicator is on
 * screen, the producer or the presented surface changed, the broad-replacement floor is in force,
 * the capture still holds the baseline screen beside a new one, or the baseline may predate a side
 * effect. One failed check disarms the rule for the rest of the run.
 *
 * Two equal captures ~110 ms apart cannot exclude a later stage nothing marks: a toast standing in
 * for navigation, a plateau between transition stages, a late value write. That is the trade this
 * prototype measures.
 */
const ADAPTIVE_CONFIRMATION_GAP_MS = 110;

export type AdaptiveEarlyExit = ReturnType<typeof createAdaptiveConfirmation>;

export function createAdaptiveConfirmation(params: {
  baseline: SurfaceScopedNodes | undefined;
  baselineFresh: boolean;
  appBundleId: string | undefined;
}) {
  const { baseline, appBundleId } = params;
  let armed = params.baselineFresh && baseline !== undefined && baseline.nodes.length > 0;
  let candidate: { signal: StableCaptureSignal; snapshot: SnapshotState } | undefined;
  const disarm = () => {
    armed = false;
    candidate = undefined;
  };
  return {
    /**
     * Folds one capture in. `settle`: this capture confirmed the previous one. `confirm`: take the
     * next capture after the short gap. `none`: the quiet window decides.
     */
    observe(input: {
      snapshot: SnapshotState;
      signal: StableCaptureSignal;
      /** The broad-replacement floor raised this capture's window above the producer's own. */
      floorInForce: boolean;
    }): 'settle' | 'confirm' | 'none' {
      if (!armed || !baseline) return 'none';
      const { snapshot, signal } = input;
      if (
        input.floorInForce ||
        hasBusyIndicator(snapshot) ||
        isTransitionalUnion(baseline, snapshot, appBundleId) ||
        presentedSurfaceChanged(baseline, snapshot)
      ) {
        disarm();
        return 'none';
      }
      if (candidate) {
        const confirmed =
          sameProvenance(candidate.snapshot, snapshot) &&
          stableCaptureSignalsEqual(candidate.signal, signal);
        disarm();
        return confirmed ? 'settle' : 'none';
      }
      if (!differsFromBaseline(baseline, snapshot, appBundleId)) return 'none';
      candidate = { signal, snapshot };
      return 'confirm';
    },
    /** A private-AX recovery re-read the screen through another backend. */
    disarm,
    /** The wait before the confirming capture. */
    confirmGapMs: ADAPTIVE_CONFIRMATION_GAP_MS,
  };
}

/**
 * A navigation transition can publish both screens at once, and that union can hold still across
 * two captures. A capture that keeps most of the baseline while adding half as much again is that
 * union, not a settled screen.
 */
const UNION_RETAINED_RATIO = 0.8;
const UNION_GROWTH_RATIO = 0.5;

function isTransitionalUnion(
  baseline: SurfaceScopedNodes,
  snapshot: SnapshotState,
  appBundleId: string | undefined,
): boolean {
  const before = projectedSignal(snapshot, baseline.nodes, appBundleId);
  const after = projectedSignal(snapshot, snapshot.nodes, appBundleId);
  if (before.nodes.length === 0) return false;
  const shared = sharedIdentityCount(before, after);
  return (
    shared / before.nodes.length >= UNION_RETAINED_RATIO &&
    (after.nodes.length - shared) / before.nodes.length >= UNION_GROWTH_RATIO
  );
}

/**
 * One side of a baseline comparison: both sides take the capture's provenance so visibility
 * filtering applies alike, and both drop the keyboard chrome the settle diff collapses.
 */
function projectedSignal(
  snapshot: SnapshotState,
  nodes: SnapshotState['nodes'],
  appBundleId: string | undefined,
): StableCaptureSignal {
  return stableCaptureSignal({ ...snapshot, nodes: withoutSettleChrome(nodes, appBundleId) });
}

function differsFromBaseline(
  baseline: SurfaceScopedNodes,
  snapshot: SnapshotState,
  appBundleId: string | undefined,
): boolean {
  // A keyboard alone is not the action's effect: the projection drops it.
  return !stableCaptureSignalsEqual(
    projectedSignal(snapshot, baseline.nodes, appBundleId),
    projectedSignal(snapshot, snapshot.nodes, appBundleId),
  );
}

function hasBusyIndicator(snapshot: SnapshotState): boolean {
  return snapshot.nodes.some(isBusyIndicatorNode);
}

function presentedSurfaceChanged(baseline: SurfaceScopedNodes, snapshot: SnapshotState): boolean {
  const before = baseline.presentedSurface;
  const after = snapshot.presentedSurface;
  return before !== undefined && after !== undefined && before !== after;
}

function sameProvenance(left: SnapshotState, right: SnapshotState): boolean {
  return (
    left.producer === right.producer &&
    left.backend === right.backend &&
    left.presentedSurface === right.presentedSurface
  );
}
