import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { assertSnapshotScreenOrigin } from '@agent-device/contracts/capture';
import type {
  Point,
  SnapshotAddressableNode,
  SnapshotKeyboardBandFact,
  SnapshotNode,
} from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import type {
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import {
  runNodePipelineStages,
  type SelectorPipelineHooks,
} from '@agent-device/selectors/selector-pipeline';
import type { ActingPipelinePolicy } from '@agent-device/selectors/selector-pipeline-policy';
import { coveredInteractionDetails } from '@agent-device/selectors/interaction-error';
import { throwIfOffscreenTarget } from '@agent-device/selectors/interaction-offscreen';
import { toBackendContext } from '../../runtime-common.ts';
import { assertTapTargetClearOfVisibleKeyboard } from '@agent-device/selectors/keyboard-occlusion';
import {
  interactionVerb,
  type InteractionAction,
} from '@agent-device/selectors/interaction-action';

/**
 * The one construction site for "covered by another visible element" refusals, shared by the
 * node-stage runner below (ref, selector, native-ref preflight) and `selector-target-resolution.ts`'s
 * covered-target diagnosis probe. `find ... focus` builds the same detail shape through
 * {@link coveredInteractionDetails}, so both producers report one shape.
 *
 * When the occlusion scan could name the cover (`node.coveredBy`), the refusal says so in a typed
 * `coveredBy` detail and in the hint — Playwright's "intercepts pointer events" shape: the agent
 * learns what to dismiss without re-guessing from a screenshot. Covers from backend-policy
 * annotations carry no identity, and those refusals keep the generic hint rather than guessing.
 * The cover is diagnosis only: no ref is ever surfaced as actionable for it.
 */
export function buildCoveredInteractionError(params: {
  label: string;
  node: SnapshotAddressableNode;
  action: InteractionAction;
  selector?: string;
}): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      `${params.label} is covered by another visible element and cannot ${interactionVerb(params.action)} safely`,
      coveredInteractionDetails(params.node, { selector: params.selector }),
    ),
    'no',
  );
}

/**
 * Every node stage this action's row declares, plus the covered and keyboard refusals the
 * interaction runtime owns. Which stages run is the row's decision; every acting path — selector,
 * ref, and the native-ref preflight — enters them here, which is what keeps the native-ref fast
 * path from succeeding on a target the shared rules would refuse.
 *
 * Each path hands in the resolver that produces the point it taps with, and taps the point that
 * comes back, so the keyboard guard measures the coordinate the interaction is actually made of and no
 * path derives a second one. A path whose point can fail to exist — the native-ref fast path taps by
 * ref, reading the rect center the platform aims at — says so in its resolver's return type.
 */
export async function runInteractionPipelineStages<TPoint extends Point | null>(params: {
  policy: ActingPipelinePolicy;
  nodes: SnapshotState['nodes'];
  /** The keyboard band `nodes`' capture measured, when it measured one (#2660). */
  keyboard?: SnapshotKeyboardBandFact;
  node: SnapshotNode;
  action: InteractionAction;
  label: string;
  hooks: SelectorPipelineHooks;
  resolveTapPoint: (node: SnapshotAddressableNode) => TPoint;
}): Promise<{ node: SnapshotAddressableNode; tapPoint: TPoint }> {
  await assertSnapshotScreenOrigin(params.nodes, params.label);
  const target = await runNodePipelineStages(
    params.policy,
    params.nodes,
    params.node,
    params.hooks,
  );
  if (target.kind === 'occluded') {
    throw buildCoveredInteractionError({
      label: params.label,
      node: target.node,
      action: params.action,
    });
  }
  const tapPoint = params.resolveTapPoint(target.node);
  assertTapTargetClearOfVisibleKeyboard({
    nodes: params.nodes,
    node: target.node,
    action: params.action,
    label: params.label,
    ...(params.keyboard ? { keyboard: params.keyboard } : {}),
    tapPoint,
  });
  return { node: target.node, tapPoint };
}

// The runtime paths' end-to-end off-screen enforcement point: the shared rule
// (`throwIfOffscreenTarget`) with the backend's optional
// `confirmOffscreenTargetVisible` hook as its #1542 rescue read. A backend that
// omits the hook refuses on the bulk tree's verdict unchanged.
//
// Exported (not just for callers here) for ADR 0011 registry honesty:
// interaction-guarantees.ts's `offscreen` cells point their `via` at this
// function, not at the contracts predicate alone, since this is the actual
// end-to-end enforcement point.
export async function throwIfOffscreenInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: Parameters<typeof throwIfOffscreenTarget>[2],
): Promise<SnapshotNode> {
  const confirm = runtime.backend.confirmOffscreenTargetVisible;
  return await throwIfOffscreenTarget(
    node,
    nodes,
    failure,
    confirm
      ? async (target, rootViewport) =>
          await confirm.call(
            runtime.backend,
            toBackendContext(runtime, options),
            target,
            rootViewport,
          )
      : undefined,
  );
}

/**
 * The capture that measured a resolved target's point: its `preAction` tree, when the dispatched
 * node is one of that tree's nodes. The rescue above returns a copy patched with a live rect, which
 * is not, so a rescued point (and a raw coordinate) has no observation. A backend may draw evidence
 * about the tap point only from this value.
 */
export function pointObservationOf(
  target: ResolvedInteractionTarget,
): SurfaceScopedNodes | undefined {
  if (target.kind === 'point' || !target.node || !target.preAction) return undefined;
  return target.preAction.nodes.includes(target.node) ? target.preAction : undefined;
}
