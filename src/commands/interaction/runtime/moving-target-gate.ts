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
  CommandSessionRecord,
  MovingTargetBaseline,
} from '@agent-device/contracts/runtime-contract';
import { nodeRectByIdentity } from '@agent-device/ad-script';
import { now, sleep } from '../../runtime-common.ts';
import { captureInteractionSnapshot } from './interaction-snapshot-capture.ts';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { resolveInteractionTarget } from './resolution.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';

/**
 * The moving-target gate (#3471): a press or click resolved from a selector or `@ref` must not
 * dispatch at a point an in-flight transition has already vacated. A raw-coordinate target has no
 * resolved element to re-observe, so the gate passes it through. A capture is one instant's
 * photograph of a surface that may still be rearranging itself, and the ADB-backed Android helper is
 * measured reporting frames in flight — so an interaction issued right after an action that moved
 * the UI can resolve a point the target has already left and report success on the vacancy. The exposure is the runtime path's own capture-to-dispatch
 * distance, so the gate is backend-neutral.
 *
 * Two judgements decide when it is real: {@link movingTargetGateDecision} asks whether this position
 * is still owed a second observation, and kernel's `areCapturedRectsAtSamePosition` asks whether the
 * target has stopped — that one lives in `@agent-device/kernel/rect-center` because the post-gesture
 * no-effect comparison judges the same pair of capture rects and must not hold its own band. Both
 * are pure over values the caller already holds, so neither is re-derived per platform. The window is
 * anchored on the mutation's END, so the gate waits out only what is LEFT of it — which is also why
 * the refusal's hint names `--settle` as the caller-opted superset.
 *
 * This is the seam that spends the window, in front of the dispatch and behind every pre-dispatch
 * guard that already judged the target (occlusion, off-screen, keyboard), so it re-decides none of
 * them: it takes the second and third observations, and dispatches the requested interaction at the
 * position two of them agree on.
 *
 * Agreement dispatches rather than refuses: a control that settled inside the window is the target
 * the caller asked for, at where it ended up. The refusal is reserved for a target the window could not
 * settle, where a coordinate would be a guess.
 *
 * Re-resolving rather than re-pointing is deliberate: the recheck spends the whole resolution path,
 * so every shared guard re-runs against the fresh observation and the response's identity fields
 * describe the node actually dispatched at.
 */
export async function guardResolvedTargetAgainstMotion(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  resolved: ResolvedInteractionTarget,
): Promise<ResolvedInteractionTarget> {
  // A raw-coordinate press has no resolved element that could be at rest, and a target the capture
  // gave no measurable rect for has already met the guard that owns that case.
  if (resolved.kind === 'point') return resolved;
  if (!resolved.node?.rect) return resolved;
  // Two guards own the identity of what they already resolved and refuse a second look at it: a
  // replay step's post-resolution identity guard (ADR 0012 step 4) judges THIS resolution against its
  // own verification tree, and a mutating `find`'s carried node (#1654) is the node its locator just
  // picked. Re-resolving under either swaps evidence for a different observation, so this asks
  // before spending the session read the answer would then discard.
  if (params.expectedResolvedTarget || params.preresolvedTarget) return resolved;
  const gate = await readMovingTargetGate(runtime, options, resolved.node, resolved.preAction);
  if (!gate) return resolved;
  return await resolveAtRestTarget(runtime, options, params, resolved, gate);
}

/** How long after a mutation its target positions stay owed a second observation. */
export const MOVING_TARGET_GATE_WINDOW_MS = 500;

/**
 * How far apart the two observations must be for agreeing to mean "at rest". Below one capture
 * round trip, two observations of a still-moving target agree by timing rather than by the target
 * having stopped, and the gate would certify a position it never measured. The gate therefore waits
 * `max(remaining window, this)` before re-observing.
 */
export const MOVING_TARGET_GATE_SAMPLE_GAP_MS = 50;

type MovingTargetGateDecision =
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

/** A press owed a re-observation: the recheck decision, which carries the wait it owes. */
type MovingTargetRecheck = Extract<MovingTargetGateDecision, { kind: 'recheck' }>;

/**
 * The gate's idle-path cost, stated as code: one session-record read, no capture. A press whose
 * target the last action's own tree already shows at the resolved rect is `stationary`, and one
 * taken after the window has closed is `not-recent`; both dispatch at the point already resolved.
 */
async function readMovingTargetGate(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  resolvedNode: SnapshotNode,
  resolvedSurface: SurfaceScopedNodes | undefined,
): Promise<MovingTargetRecheck | undefined> {
  const baseline = await readGateBaseline(runtime, options);
  if (!baseline) return undefined;
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: baseline.finishedAt,
    targetShownAtRest: baselineShowsTargetAtRest(baseline, resolvedNode, resolvedSurface),
    nowMs: now(runtime),
  });
  return decision.kind === 'recheck' ? decision : undefined;
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
 * this instant separates them. The tier that carries evidence is `resolveAtRestTarget`, which spends
 * two fresh observations and requires them to agree on a position and a surface. This one buys the
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
 * The baseline the gate screens against. A session store that carries none is the non-daemon case —
 * an in-process runtime owns no mutation history — and a gate with no history has nothing to worry
 * about.
 */
async function readGateBaseline(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
): Promise<CommandSessionRecord['movingTargetBaseline']> {
  const session: CommandSessionRecord | undefined = await runtime.sessions.get(
    options.session ?? 'default',
  );
  return session?.movingTargetBaseline;
}

/**
 * Re-resolves past the end of the window and one sample gap later; agreement is the resting
 * position. A re-resolution that fails outright is left to propagate: the resolution path's own typed
 * refusal (`selector_not_found`, `ref_not_found`, both `dispatched: 'no'`) describes a target the
 * wait lost more accurately than a motion refusal would, and the window has by then passed, so the
 * caller's retry is a fresh judgement rather than the same one.
 */
async function resolveAtRestTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  gate: MovingTargetRecheck,
): Promise<ResolvedInteractionTarget> {
  // Measured, not arithmetic: the refused press reports the wait it actually paid, which is what a
  // caller tuning `--settle` against this error needs.
  const waitedFrom = now(runtime);
  await sleep(runtime, gate.waitMs);
  const first = await reObserveTarget(runtime, options, params);
  if (!first.measured) throw motionRefusal(resolved, undefined, now(runtime) - waitedFrom);
  await sleep(runtime, MOVING_TARGET_GATE_SAMPLE_GAP_MS);
  const second = onSameSurface(first, await reObserveTarget(runtime, options, params));
  if (second.measured && areCapturedRectsAtSamePosition(first.rect, second.rect))
    return second.resolved;
  throw motionRefusal(resolved, second.rect, now(runtime) - waitedFrom);
}

/**
 * Rest is one position on one surface, which is why the screening refuses to compare positions
 * across surfaces at all (#2438). A look taken on another presentation — a system sheet arriving
 * during the sample gap can carry the same control at the same rect — therefore measures nothing
 * about where this target came to rest, and is demoted to the shape that already means that: it
 * cannot certify agreement, and no position from it is reported as somewhere the target moved to.
 */
function onSameSurface(
  first: MovingTargetObservation & { measured: true },
  next: MovingTargetObservation,
): MovingTargetObservation {
  return next.measured && next.surfaceBundleId === first.surfaceBundleId
    ? next
    : { measured: false, rect: undefined, resolved: next.resolved };
}

/** One look at the target: what it resolved to, and whether that look measured a position. */
type MovingTargetObservation = MovingTargetMeasurement & {
  resolved: ResolvedInteractionTarget;
};

/** Whether a look produced a position of its own, or nothing to compare against. */
type MovingTargetMeasurement =
  /** The position this observation's own capture reported for the target, on that capture's surface. */
  | MovingTargetMeasured
  /**
   * No position of its own. Two of these would "agree" trivially — rest certified by a
   * non-measurement, the one outcome the gate must never produce — so the first of them ends the
   * recheck, and a refusal reports no `movedToRect` rather than a stale one.
   */
  | { measured: false; rect: undefined };

/**
 * A look that measured the target: where it put it, and on which surface. The surface rides along
 * because a rect is only comparable to one measured on the same presentation (#2438).
 */
type MovingTargetMeasured = {
  measured: true;
  rect: Rect;
  surfaceBundleId: string | undefined;
};

/**
 * One observation of the same target, asked as the original question rather than a narrower one.
 *
 * A selector re-resolution re-observes by itself — capture is the first thing its resolution spends.
 * A `@ref` resolution deliberately spends no capture (ADR 0014 binds a ref to its authorized frame),
 * so the ref branch takes the observation first: publishing it into the session is what lets
 * ADR 0014's reconciliation adopt the capture's coordinates for a same-identity node, which is the
 * sanctioned way a ref's position moves. `measureRefObservation` then asks whether that adoption is
 * what actually got dispatched — a resolution that kept its authorized frame node measured nothing
 * here, and the gate refuses rather than comparing one stale rect to itself.
 */
async function reObserveTarget(
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
    return rect
      ? { measured: true, resolved, rect, surfaceBundleId }
      : { measured: false, resolved, rect: undefined };
  }
  const { snapshot } = await captureInteractionSnapshot(runtime, options, true);
  const resolved = await resolveInteractionTarget(runtime, options, params);
  return { resolved, ...measureRefObservation(surfaceScopedNodes(snapshot), resolved) };
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
 * The hint published beside every `target_still_moving` refusal, owned by the refusal's module so
 * the reason cannot be published without its recovery.
 *
 * A selector re-resolves against a fresh capture and can be retried as-is. An `@ref` cannot survive
 * the wait: the capture a `wait` takes retires the ref frame (ADR 0014), which is the same reason
 * the off-screen guard sends its `@ref` refusals to a selector. The selector is quoted for the
 * caller's shell the way the daemon's other recovery hints quote values (`shellQuoteIfNeeded`), so
 * a label carrying an apostrophe cannot turn the suggested command into a copy-paste failure.
 */
function targetStillMovingHint(params: { selector: string | undefined }): string {
  const reobserve = params.selector
    ? `Run wait ${shellQuoteIfNeeded(params.selector)} and retry with the same selector`
    : 'Run snapshot -i and retry with a selector (text=/id=) rather than this @ref — re-observing retires the ref frame';
  return (
    'The target had no confirmed resting position when the transition window after the previous action ran ' +
    `out, so nothing was dispatched. ${reobserve}; or pass --settle to have the action itself wait for the ` +
    'UI to go quiet.'
  );
}

/**
 * The refusal, keyed on the reason the whole interaction surface shares and raised beside the guard
 * that owns it. `rect` is the position the caller's own resolution produced and `movedToRect` where
 * the last re-observation found the target — the pair that says which way the surface is going.
 * `movedToRect` is the one optional member: a re-observation that measured nothing (the ref kept its
 * authorized frame node) has no position to name, and an absent value is the honest report rather
 * than a stale one.
 */
function motionRefusal(
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  movedToRect: Rect | undefined,
  waitedMs: number,
): Error {
  const selector = resolved.target.kind === 'selector' ? resolved.target.selector : undefined;
  const ref = resolved.target.kind === 'ref' ? resolved.target.ref : undefined;
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
        hint: targetStillMovingHint({ selector }),
      },
    ),
    'no',
  );
}
