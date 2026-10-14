import type { SurfaceScopedNodes } from './interaction.ts';

/**
 * The pure half of the moving-target gate (#3471): a press must not dispatch at a point an
 * in-flight transition has already vacated. A capture is one instant's photograph of a surface that
 * may still be rearranging itself, and the ADB-backed Android helper is measured reporting frames in
 * flight — so a press issued right after an action that moved the UI can resolve a point the target
 * has already left and report success on the vacancy. The exposure is the runtime path's own
 * capture-to-dispatch distance, so the gate is backend-neutral.
 *
 * Two judgements decide when it is real: {@link movingTargetGateDecision} asks whether this position
 * is still owed a second observation, and kernel's `areCapturedRectsAtSamePosition` asks whether the
 * target has stopped — that one lives in `@agent-device/kernel/rect-center` because the post-gesture
 * no-effect comparison judges the same pair of capture rects and must not hold its own band. Both
 * are pure over values the caller already holds, so neither is re-derived per platform. The window is
 * anchored on the mutation's END, so the gate waits out only what is LEFT of it — which is also why
 * the refusal's hint names `--settle` as the caller-opted superset.
 *
 * What cannot be decided over values — spending the window, taking the re-observations, and the
 * refusal with its reason (`INTERACTION_ERROR_REASONS.targetStillMoving`) and hint — lives in
 * `src/commands/interaction/runtime/moving-target-gate.ts`, which produces all three together.
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
  /**
   * The tree the action acted through: its resolution's own observation, or the settled one its
   * `--settle` published as rest.
   */
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
