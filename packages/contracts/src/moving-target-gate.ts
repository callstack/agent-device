import type { Rect } from '@agent-device/kernel/snapshot';
import { normalizeRect } from '@agent-device/kernel/rect-center';
import type { SurfaceScopedNodes } from './interaction.ts';

/**
 * The moving-target gate (#3471): a press must not dispatch at a point an in-flight transition has
 * already vacated. A capture is one instant's photograph of a surface that may still be rearranging
 * itself, and the ADB-backed Android helper is measured reporting frames in flight — so a press
 * issued right after an action that moved the UI can resolve a point the target has already left and
 * report success on the vacancy. The exposure is the runtime path's own capture-to-dispatch
 * distance, so the gate is backend-neutral.
 *
 * Two judgements decide when it is real, both pure over values the caller already holds so neither
 * is re-derived per platform: {@link movingTargetGateDecision} asks whether this position is still
 * owed a second observation, {@link movingTargetRectsStable} asks whether the target has stopped.
 * The window is anchored on the mutation's END, so the gate waits out only what is LEFT of it —
 * which is also why the refusal's hint names `--settle` as the caller-opted superset.
 */

/** How long after a mutation its target positions stay owed a second observation. */
export const MOVING_TARGET_GATE_WINDOW_MS = 500;

/**
 * How far apart the two observations must be for agreeing to mean "at rest". Below one capture
 * round trip, two observations of a still-moving target agree by timing rather than by the target
 * having stopped, and the gate would certify a position it never measured. The gate therefore waits
 * `max(remaining window, this)` before re-observing.
 */
export const MOVING_TARGET_GATE_SAMPLE_GAP_MS = 50;

/**
 * How far a rect may shift between the two observations and still count as the same position.
 * Matches the tolerance the post-gesture surface comparison uses
 * (`src/daemon/interaction-surface-signature.ts`), so capture rounding never reads as motion.
 */
export const MOVING_TARGET_GATE_RECT_TOLERANCE_PX = 1;

/**
 * The tree a mutation resolved against, kept on the session with the instant that mutation
 * finished, so the next action can ask whether its own coordinates are still in play.
 *
 * A {@link SurfaceScopedNodes} rather than a whole capture: the gate compares node positions on one
 * surface, and the surface scoping is what keeps an iOS system-sheet tree from ever being compared
 * against app content (#2438).
 */
export type MovingTargetBaseline = Readonly<{
  /**
   * When the action finished, not when it began: the gate waits out what is LEFT of the window. The
   * daemon stamps it with `Date.now()`; the gate compares it against `now(runtime)`, so a runtime
   * that installs a clock of its own (a scenario pinning the window) states this value in that
   * clock's time too. Production installs none, so both sides read the wall clock.
   */
  finishedAt: number;
  /** The pre-action tree — the observation the action's own resolution came out of. */
  tree: SurfaceScopedNodes;
}>;

export type MovingTargetGateDecision =
  /** The session holds no baseline: nothing has resolved a mutation recently enough to matter. */
  | { kind: 'idle' }
  /** The last resolving mutation finished at or beyond the window ago; the resolved point stands. */
  | { kind: 'not-recent' }
  /** Inside the window, but the pre-action tree already shows this node at the resolved rect. */
  | { kind: 'stationary' }
  /** Inside the window and disturbed: re-observe at the end of it before dispatching. */
  | { kind: 'recheck'; waitMs: number };

/**
 * Whether a resolved rect is still owed a second observation, from the session's mutation clock and
 * its pre-action tree's verdict on the resolved node. A missing verdict (no baseline tree) can only
 * mean "not shown at rest", so it rechecks.
 */
export function movingTargetGateDecision(params: {
  /** When the session's last resolving mutation finished; `undefined` when the session is idle. */
  baselineFinishedAtMs: number | undefined;
  /** Whether the action's own pre-action tree already shows the resolved node at this rect. */
  targetShownAtRest: boolean;
  nowMs: number;
}): MovingTargetGateDecision {
  if (params.baselineFinishedAtMs === undefined) return { kind: 'idle' };
  const ageMs = params.nowMs - params.baselineFinishedAtMs;
  if (ageMs >= MOVING_TARGET_GATE_WINDOW_MS) return { kind: 'not-recent' };
  if (params.targetShownAtRest) return { kind: 'stationary' };
  return {
    kind: 'recheck',
    waitMs: Math.max(MOVING_TARGET_GATE_WINDOW_MS - ageMs, MOVING_TARGET_GATE_SAMPLE_GAP_MS),
  };
}

/**
 * Whether two consecutive observations put the target at the same position. A rect either
 * observation could not measure is not stable: absence is the surface having changed under the
 * point, which is the exposure the gate exists to catch.
 */
export function movingTargetRectsStable(
  first: Rect | undefined,
  second: Rect | undefined,
): boolean {
  // `normalizeRect` is the repository's one "this rect reports a position" rule, so the gate can
  // never measure a target the tap-point resolver itself would refuse to place. The tolerance stays
  // here rather than in kernel's 0.5 px `areRectsApproximatelyEqual`: that one asks whether two
  // values denote one point, this one asks whether capture rounding counts as motion, and 1 px is
  // the band the post-gesture surface comparison already uses.
  const a = normalizeRect(first);
  const b = normalizeRect(second);
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= MOVING_TARGET_GATE_RECT_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= MOVING_TARGET_GATE_RECT_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= MOVING_TARGET_GATE_RECT_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= MOVING_TARGET_GATE_RECT_TOLERANCE_PX
  );
}

/**
 * The hint published beside a `target_still_moving` refusal — the recovery that works, with its
 * wording owned here so every producer publishes one text. Pairing the two is a convention rather
 * than something this module enforces: the reason is a literal in the vocabulary every interaction
 * adapter reads (`INTERACTION_ERROR_REASONS.targetStillMoving` in
 * `packages/selectors/src/interaction-error.ts`), so a producer could raise it without this hint.
 * The runtime moving-target gate is the only producer today and publishes both together.
 *
 * A selector re-resolves against a fresh capture and can be retried as-is. An `@ref` cannot survive
 * the wait: the capture a `wait` takes retires the ref frame (ADR 0014), which is the same reason
 * the off-screen guard sends its `@ref` refusals to a selector.
 */
export function targetStillMovingHint(params: { selector: string | undefined }): string {
  const reobserve = params.selector
    ? `Run wait '${params.selector}' and retry with the same selector`
    : 'Run snapshot -i and retry with a selector (text=/id=) rather than this @ref — re-observing retires the ref frame';
  return (
    'The target was still moving when the transition window after the previous action ran out, so no resting ' +
    `position could be confirmed and nothing was tapped. ${reobserve}; or pass --settle to have the action itself ` +
    'wait for the UI to go quiet.'
  );
}
