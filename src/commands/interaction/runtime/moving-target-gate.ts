import {
  MOVING_TARGET_GATE_SAMPLE_GAP_MS,
  movingTargetGateDecision,
  movingTargetRectsStable,
  targetStillMovingHint,
  type MovingTargetGateDecision,
} from '@agent-device/contracts/moving-target-gate';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import type { ResolvedInteractionTarget } from '@agent-device/contracts/interaction';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '@agent-device/contracts/runtime-contract';
import { nodeRectByIdentity } from '@agent-device/ad-script';
import { now, sleep } from '../../runtime-common.ts';
import { captureInteractionSnapshot } from './interaction-snapshot-capture.ts';
import { tryResolveRefNode } from './ref-target-resolution.ts';
import { resolveInteractionTarget, type InteractionTarget } from './resolution.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';

/**
 * The moving-target gate (#3471): the seam that spends the window, in front of the tap and behind
 * every pre-dispatch guard that already judged the target (occlusion, off-screen, keyboard), so it
 * re-decides none of them. The decision and its budget live in
 * `@agent-device/contracts/moving-target-gate`; what lives here is the part that can only be done
 * with a runtime — taking the second and third observations, and putting the tap at the position two
 * of them agree on.
 *
 * Agreement dispatches rather than refuses: a control that settled inside the window is the tap the
 * caller asked for, at where it ended up. The refusal is reserved for a target the window could not
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
  const gate = await readMovingTargetGate(runtime, options, resolved.node);
  if (!gate) return resolved;
  return await resolveAtRestTarget(runtime, options, params, resolved, gate);
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
): Promise<MovingTargetRecheck | undefined> {
  const baseline = await readGateBaseline(runtime, options);
  if (!baseline) return undefined;
  // Screening is the one thing the press gets for free: the last action's own tree, never a new
  // observation. `nodeRectByIdentity` answers it fail-closed — absent, ambiguous and unmeasurable
  // all read as "not shown at rest" — because a guard whose failure mode is a refused tap must never
  // grant rest on positional coincidence.
  const carried = nodeRectByIdentity(baseline.tree.nodes, resolvedNode);
  const decision = movingTargetGateDecision({
    baselineFinishedAtMs: baseline.finishedAt,
    targetShownAtRest: carried !== undefined && movingTargetRectsStable(carried, resolvedNode.rect),
    nowMs: now(runtime),
  });
  return decision.kind === 'recheck' ? decision : undefined;
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
  if (!first.measured || !first.rect)
    throw motionRefusal(resolved, undefined, now(runtime) - waitedFrom);
  await sleep(runtime, MOVING_TARGET_GATE_SAMPLE_GAP_MS);
  const second = await reObserveTarget(runtime, options, params);
  if (second.measured && movingTargetRectsStable(first.rect, second.rect)) return second.resolved;
  throw motionRefusal(
    resolved,
    { firstRect: first.rect, secondRect: second.rect },
    now(runtime) - waitedFrom,
  );
}

/** One look at the target, and whether that look actually measured the surface. */
type MovingTargetObservation = {
  resolved: ResolvedInteractionTarget;
  rect: Rect | undefined;
  /**
   * Whether the rect came from the capture this observation took. A resolution that kept its
   * authorized ref frame node instead measured nothing, and two of those would "agree" trivially —
   * rest certified by a non-measurement, the one outcome the gate must never produce.
   */
  measured: boolean;
};

/**
 * One observation of the same target, asked as the original question rather than a narrower one.
 *
 * A selector re-resolution re-observes by itself — capture is the first thing its resolution spends.
 * A `@ref` resolution deliberately spends no capture (ADR 0014 binds a ref to its authorized frame),
 * so the ref branch takes the observation first: publishing it into the session is what lets
 * ADR 0014's reconciliation adopt the capture's coordinates for a same-identity node, which is the
 * sanctioned way a ref's position moves.
 *
 * Whether that adoption happened is already what the resolution reports: it publishes the tree it
 * resolved against as its `preAction`, and that tree IS this capture when the coordinates were
 * adopted. Reading provenance rather than re-matching the node answers the question the gate
 * actually asks — "did this position come from the capture I just took" — and keeps the answer
 * correct for the nodes whose identity is not unique in the tree (an unlabeled button row is one
 * role and no label), which is most of what a screen offers. A resolution that kept its authorized
 * frame node measured nothing here, and the gate refuses rather than comparing one stale rect to
 * itself.
 */
async function reObserveTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
): Promise<MovingTargetObservation> {
  if (options.target.kind !== 'ref') {
    const resolved = await resolveInteractionTarget(runtime, options, params);
    return { resolved, rect: resolvedRect(resolved), measured: true };
  }
  const { snapshot } = await captureInteractionSnapshot(runtime, options, true);
  const resolved = await resolveInteractionTarget(runtime, options, params);
  const resolvedNodeRect = resolvedRect(resolved);
  const inCapture = tryResolveRefNode(snapshot.nodes, options.target.ref, {
    fallbackLabel: options.target.fallbackLabel ?? '',
  });
  const observedRect = inCapture.kind === 'resolved' ? inCapture.resolved.node.rect : undefined;
  return {
    resolved,
    rect: observedRect,
    measured: observedRect !== undefined && movingTargetRectsStable(observedRect, resolvedNodeRect),
  };
}

function resolvedRect(resolved: ResolvedInteractionTarget): Rect | undefined {
  return 'node' in resolved ? resolved.node?.rect : undefined;
}

/**
 * The refusal, keyed on the shared reason constant and raised beside the guard that owns it. `rect`
 * is the position the caller's own resolution produced and `movedToRect` where the gate's
 * re-observations found the target instead — the pair that says which way the surface is going.
 */
function motionRefusal(
  resolved: Exclude<ResolvedInteractionTarget, { kind: 'point' }>,
  disagreement: { firstRect: Rect; secondRect: Rect | undefined } | undefined,
  waitedMs: number,
): Error {
  const selector = resolved.target.kind === 'selector' ? resolved.target.selector : undefined;
  const ref = resolved.target.kind === 'ref' ? resolved.target.ref : undefined;
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      selector
        ? `Selector ${selector} is still moving, so no resting position could be confirmed to press`
        : `Ref ${ref} is still moving, so no resting position could be confirmed to press`,
      {
        reason: INTERACTION_ERROR_REASONS.targetStillMoving,
        ...(selector !== undefined ? { selector } : { ref }),
        ...(resolved.node?.rect ? { rect: resolved.node.rect } : {}),
        ...(disagreement?.secondRect ? { movedToRect: disagreement.secondRect } : {}),
        waitedMs,
        hint: targetStillMovingHint({ selector }),
      },
    ),
    'no',
  );
}
