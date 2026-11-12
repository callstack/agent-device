/**
 * The motion check of pre-dispatch admission (#3471, ADR 0039): a press or click resolved from a
 * selector or `@ref` must not dispatch at a point an in-flight transition has already vacated. A
 * capture is one instant's photograph of a surface that may still be rearranging itself, and the
 * ADB-backed Android helper is measured reporting frames in flight — so an interaction issued right
 * after an action that moved the UI can resolve a point the target has already left and report
 * success on the vacancy.
 *
 * Two judgements decide when it is real: {@link movingTargetGateDecision} asks whether this position
 * is still owed a second observation, and kernel's `areCapturedRectsAtSamePosition` asks whether the
 * target has stopped — that one lives in `@agent-device/kernel/rect-center` because the post-gesture
 * no-effect comparison judges the same pair of capture rects and must not hold its own band. The
 * window is anchored on the mutation's END, so the check waits out only what is LEFT of it — which
 * is also why the refusal's hint names `--settle` as the caller-opted superset.
 *
 * This module owns what the check judges. `pre-dispatch-admission.ts` owns when it looks, and the
 * request budget every look and sleep runs under. Re-resolving rather than re-pointing is
 * deliberate: each look spends the whole resolution path, so every shared guard re-runs against the
 * fresh observation and the response's identity fields describe the node actually dispatched at.
 */
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import type {
  InteractionTarget,
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { areCapturedRectsAtSamePosition } from '@agent-device/kernel/rect-center';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import type {
  AgentDeviceRuntime,
  CommandContext,
  MovingTargetBaseline,
} from '@agent-device/contracts/runtime-contract';
import { nodeRectByIdentity } from '@agent-device/ad-script';
import { now } from '../../runtime-common.ts';
import { captureInteractionSnapshot } from './interaction-snapshot-capture.ts';
import { requireSnapshotSession } from './selector-read-shared.ts';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { resolveInteractionTarget } from './resolution.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';

/**
 * The motion check's screening: one session-record read, no capture. A target the previous action's
 * own tree already shows at the resolved rect is `stationary`, and one resolved after the window has
 * closed is `not-recent`; both pass at the point already resolved. Otherwise the check waits, with
 * its transition window anchored here, once.
 */
export async function screenMotion(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  resolvedNode: SnapshotNode,
  resolvedSurface: SurfaceScopedNodes | undefined,
): Promise<{ kind: 'pass' } | { kind: 'wait'; wait: MotionWait }> {
  // A session store that carries no baseline is the non-daemon case: an in-process runtime owns no
  // mutation history, and a check with no history has nothing to worry about.
  const session = await runtime.sessions.get(options.session ?? 'default');
  const baseline = session?.movingTargetBaseline;
  if (!baseline) return { kind: 'pass' };
  const policy = MOTION_POLICIES[runtime.backend.platform === 'android' ? 'android' : 'default'];
  const nowMs = now(runtime);
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: baseline.finishedAt,
    targetShownAtRest: baselineShowsTargetAtRest(baseline, resolvedNode, resolvedSurface),
    nowMs,
    windowMs: policy.windowMs,
  });
  if (decision.kind !== 'recheck') return { kind: 'pass' };
  const firstLookAtMs = policy.firstLook === 'after-window' ? nowMs + decision.waitMs : nowMs;
  return {
    kind: 'wait',
    wait: {
      policy,
      firstLookAtMs,
      giveUpAtMs: Math.max(nowMs + decision.waitMs, firstLookAtMs + policy.quietMs),
    },
  };
}

/** How long after a mutation its target positions stay owed a second observation. */
export const MOVING_TARGET_GATE_WINDOW_MS = 500;

/**
 * How far apart the two observations must be for agreeing to mean "at rest". Below one capture
 * round trip, two observations of a still-moving target agree by timing rather than by the target
 * having stopped, and the check would certify a position it never measured. It is also the interval
 * between looks.
 */
export const MOVING_TARGET_GATE_SAMPLE_GAP_MS = 50;

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
  windowMs?: number;
}):
  /** The session holds no baseline: nothing has resolved a mutation recently enough to matter. */
  | { kind: 'idle' }
  /** The last resolving mutation finished at or beyond the window ago; the resolved point stands. */
  | { kind: 'not-recent' }
  /** Inside the window, but the pre-action tree already shows this node at the resolved rect. */
  | { kind: 'stationary' }
  /** Inside the window and disturbed: re-observe at the end of it before dispatching. */
  | { kind: 'recheck'; waitMs: number } {
  if (params.baselineFinishedAtMs === undefined) return { kind: 'idle' };
  const ageMs = params.nowMs - params.baselineFinishedAtMs;
  const windowMs = params.windowMs ?? MOVING_TARGET_GATE_WINDOW_MS;
  if (ageMs >= windowMs) return { kind: 'not-recent' };
  if (params.targetShownAtRest) return { kind: 'stationary' };
  return {
    kind: 'recheck',
    waitMs: Math.max(windowMs - ageMs, MOVING_TARGET_GATE_SAMPLE_GAP_MS),
  };
}

/**
 * How the motion check waits for a target owed a re-observation. Android looks immediately and
 * accepts a measured quiet interval inside its longer window. Other backends look once the window
 * has passed and accept two agreeing looks one sample gap apart. `quietMs` is how long the position
 * must hold across looks; `minLooks` is how many looks are taken before the window may end the wait.
 */
const MOTION_POLICIES = {
  default: {
    windowMs: MOVING_TARGET_GATE_WINDOW_MS,
    quietMs: MOVING_TARGET_GATE_SAMPLE_GAP_MS,
    minLooks: 2,
    firstLook: 'after-window',
  },
  android: { windowMs: 1_500, quietMs: 100, minLooks: 3, firstLook: 'immediately' },
} as const;

/** A target owed re-observation: when to take the first look, and when the window gives up. */
export type MotionWait = Readonly<{
  policy: (typeof MOTION_POLICIES)[keyof typeof MOTION_POLICIES];
  firstLookAtMs: number;
  giveUpAtMs: number;
}>;

/**
 * Judges one look against the previous one. Agreement dispatches rather than refuses: a control
 * that settled inside the window is the target the caller asked for, at where it ended up.
 *
 * Rest is one position on one surface, which is why the screening refuses to compare positions
 * across surfaces at all (#2438). A look taken on another presentation — a system sheet arriving
 * during the sample gap can carry the same control at the same rect — therefore measures nothing
 * about where this target came to rest: it refuses like a look that measured nothing, and no
 * position from it is reported as somewhere the target moved to.
 */
export function judgeMotionLook(
  look: MovingTargetObservation,
  previous: MovingTargetObservation | undefined,
  restingSinceMs: number,
  policy: MotionWait['policy'],
):
  /** The position held for the policy's quiet interval: dispatch at this look's resolution. */
  | { kind: 'pass'; admitted: ResolvedInteractionTarget }
  /** Not yet at rest; the position has held since `restingSinceMs`. */
  | { kind: 'wait'; restingSinceMs: number }
  /** The look measured no position on the surface the previous looks measured. */
  | { kind: 'refuse' } {
  if (!look.measured) return { kind: 'refuse' };
  if (previous?.measured && look.surfaceBundleId !== previous.surfaceBundleId) {
    return { kind: 'refuse' };
  }
  if (!previous?.measured || !areCapturedRectsAtSamePosition(previous.rect, look.rect)) {
    return { kind: 'wait', restingSinceMs: look.observedAtMs };
  }
  return look.observedAtMs - restingSinceMs >= policy.quietMs
    ? { kind: 'pass', admitted: look.resolved }
    : { kind: 'wait', restingSinceMs };
}

/**
 * Whether the previous action's own tree already shows this target where this press resolved it —
 * the one thing the press gets for free, since that tree is the observation the action resolved
 * against and this asks nothing new of the surface.
 *
 * The surfaces have to be the same one before its positions mean anything: an iOS system sheet
 * arriving over the app publishes a tree of a different surface, and a same-identity node at the
 * same rect there is exactly the positional coincidence ADR 0014 refuses. Comparing
 * `surfaceBundleId` draws the same line `post-action-surface.ts` draws between two captures.
 *
 * `nodeRectByIdentity` then answers fail-closed — absent, ambiguous and unmeasurable all read as
 * "not shown at rest" — because a guard whose failure mode is a refused tap must never grant rest
 * on a guess.
 *
 * The claim is an inference from one tree, not stability evidence: an animation that has not moved
 * the control yet reads here exactly as a finished transition does, and no observation available at
 * this instant separates them. The tier that carries evidence is the admission loop, which spends
 * fresh looks and requires them to agree on a position and a surface. This one buys the
 * case it can decide for free — the previous transition already finished, which is what the large
 * majority of presses inside the window are — and sends everything else to be measured.
 */
function baselineShowsTargetAtRest(
  baseline: MovingTargetBaseline,
  resolvedNode: SnapshotNode,
  resolvedSurface: SurfaceScopedNodes | undefined,
): boolean {
  if (baseline.tree.surfaceBundleId !== resolvedSurface?.surfaceBundleId) return false;
  const carried = nodeRectByIdentity(baseline.tree.nodes, resolvedNode);
  return carried !== undefined && areCapturedRectsAtSamePosition(carried, resolvedNode.rect);
}

/**
 * One look at the target: what it resolved to, whether that look measured a position, and the
 * instant the look ended.
 */
export type MovingTargetObservation = MovingTargetMeasurement & {
  resolved: ResolvedInteractionTarget;
  observedAtMs: number;
};

/** Whether a look produced a position of its own, or nothing to compare against. */
type MovingTargetMeasurement =
  /**
   * The position this observation's own capture reported for the target, and on which surface. The
   * surface rides along because a rect is only comparable to one measured on the same presentation
   * (#2438).
   */
  | { measured: true; rect: Rect; surfaceBundleId: string | undefined }
  /**
   * No position of its own. Two of these would "agree" trivially — rest certified by a
   * non-measurement, the one outcome the check must never produce — so the first of them ends the
   * recheck, and a refusal reports no `movedToRect` rather than a stale one.
   */
  | { measured: false; rect: undefined };

/**
 * One observation of the same target, asked as the original question rather than a narrower one.
 *
 * A selector re-resolution re-observes by itself — capture is the first thing its resolution spends.
 * A `@ref` resolution deliberately spends no capture (ADR 0014 binds a ref to its authorized frame),
 * so the ref branch takes the observation first: publishing it into the session is what lets
 * ADR 0014's reconciliation adopt the capture's coordinates for a same-identity node, which is the
 * sanctioned way a ref's position moves. `measureRefObservation` then asks whether that adoption is
 * what actually got dispatched — a resolution that kept its authorized frame node measured nothing
 * here, and the check refuses rather than comparing one stale rect to itself.
 */
export async function reObserveTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
): Promise<MovingTargetObservation> {
  if (options.target.kind !== 'ref') {
    const resolved = await resolveInteractionTarget(runtime, options, params);
    const rect = resolvedRect(resolved);
    // A selector resolution measured its target on the surface it resolved against, which it
    // publishes as `preAction` along with the tree.
    const surfaceBundleId = resolved.preAction?.surfaceBundleId;
    const observedAtMs = now(runtime);
    return rect
      ? { measured: true, resolved, rect, surfaceBundleId, observedAtMs }
      : { measured: false, resolved, rect: undefined, observedAtMs };
  }
  // A ref names its node by index in the frame tree, so the observation has to mint refs over the
  // same node set: an interactive-only look at a full-tree frame renumbers every node it drops.
  const { snapshot: frameTree } = await requireSnapshotSession(runtime, options.session);
  const { snapshot } = await captureInteractionSnapshot(
    runtime,
    options,
    frameTree.presentation?.interactiveOnly === true,
  );
  const resolved = await resolveInteractionTarget(runtime, options, params);
  return {
    resolved,
    observedAtMs: now(runtime),
    ...measureRefObservation(surfaceScopedNodes(snapshot), resolved),
  };
}

/**
 * Whether this look measured the target, stated over the provenance the resolution itself reports.
 *
 * Rect agreement alone is not enough, and this is the hole that makes it so: ADR 0014 keeps the
 * authorized frame node when the captured node's identity differs, so a DIFFERENT control that took
 * over the ref at the frame's own coordinates would produce two agreeing "observations" while the
 * dispatch went to the stale point. The look measured something only when that reconciliation
 * REPORTED reading the dispatched node out of the observation — the one account of what got
 * dispatched that cannot drift from the rule it applied, whatever the rule becomes. The surface
 * comes from the same capture through `surfaceScopedNodes`, the way the selector branch reads its
 * resolution's `preAction`.
 */
function measureRefObservation(
  capture: SurfaceScopedNodes,
  resolved: ResolvedInteractionTarget,
): MovingTargetMeasurement {
  const rect = resolvedRect(resolved);
  const measured =
    rect !== undefined && 'adoptedFrom' in resolved && resolved.adoptedFrom === 'observation';
  return measured
    ? { measured: true, rect, surfaceBundleId: capture.surfaceBundleId }
    : { measured: false, rect: undefined };
}

function resolvedRect(resolved: ResolvedInteractionTarget): Rect | undefined {
  return 'node' in resolved ? resolved.node?.rect : undefined;
}

/**
 * The refusal, keyed on the reason the whole interaction surface shares and raised beside the guard
 * that owns it. `rect` is the position the caller's own resolution produced and `movedToRect` where
 * the last re-observation found the target — the pair that says which way the surface is going.
 * `movedToRect` is the one optional member: a re-observation that measured nothing (the ref kept its
 * authorized frame node) has no position to name, and an absent value is the honest report rather
 * than a stale one.
 *
 * The hint is owned here so the reason cannot be published without its recovery. A selector
 * re-resolves against a fresh capture and can be retried as-is. An `@ref` cannot survive the wait:
 * the capture a `wait` takes retires the ref frame (ADR 0014), which is the same reason the
 * off-screen guard sends its `@ref` refusals to a selector. The selector is quoted for the caller's
 * shell (`shellQuoteIfNeeded`), so a label carrying an apostrophe cannot turn the suggested command
 * into a copy-paste failure.
 */
export function motionRefusal(
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  movedToRect: Rect | undefined,
  waitedMs: number,
): Error {
  const selector = resolved.target.kind === 'selector' ? resolved.target.selector : undefined;
  const ref = resolved.target.kind === 'ref' ? resolved.target.ref : undefined;
  const reobserve = selector
    ? `Run wait ${shellQuoteIfNeeded(selector)} and retry with the same selector`
    : 'Run snapshot -i and retry with a selector (text=/id=) rather than this @ref — re-observing retires the ref frame';
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      selector
        ? `Selector ${selector} had no confirmed resting position when the transition window ran out`
        : `Ref ${ref} had no confirmed resting position when the transition window ran out`,
      {
        reason: INTERACTION_ERROR_REASONS.targetStillMoving,
        ...(selector !== undefined ? { selector } : { ref }),
        ...(resolved.node?.rect ? { rect: resolved.node.rect } : {}),
        ...(movedToRect ? { movedToRect } : {}),
        waitedMs,
        hint:
          'The target had no confirmed resting position when the transition window after the previous action ran ' +
          `out, so nothing was dispatched. ${reobserve}; or pass --settle to have the action itself wait for the ` +
          'UI to go quiet.',
      },
    ),
    'no',
  );
}
