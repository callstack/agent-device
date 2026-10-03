import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import { resolveRectCenter } from '@agent-device/kernel/rect-center';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import { surfaceScopedNodes } from './post-action-surface.ts';
import type {
  InteractionTarget,
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import type {
  BackendActionResult,
  BackendCommandContext,
  BackendRefTarget,
} from '../../../backend.ts';
import { toBackendContext } from '../../runtime-common.ts';
import { toBackendResult } from '../../runtime-types.ts';
import type { InteractionAction } from './interaction-resolution-request.ts';
import { tryResolveRefNode } from './ref-target-resolution.ts';
import { EXACT_REF_RESOLUTION, describeNonHittableTarget } from './resolution-disclosure.ts';
import {
  assertVisibleRefTarget,
  runInteractionPipelineStages,
} from './target-visibility-stages.ts';

/**
 * ADR 0011 native-ref preflight: `click @ref` / `fill @ref` fast paths
 * dispatch straight to `backend.tapTarget`/`fillTarget`, and a backend fast
 * path can silently "succeed" — delegation-on-error never triggers there. The
 * ref came from the stored session snapshot, so the node is already in hand:
 * run the SAME shared guards the runtime path uses against it before the
 * backend call — occlusion (`isSnapshotNodeInteractionBlocked` via
 * `assertInteractionNotBlocked`) and offscreen (the snapshot visibility resolver via
 * `assertVisibleRefTarget`) ERROR with the runtime path's exact shapes, and
 * the non-hittable annotation is returned for the fast-path result.
 *
 * Zero extra round trips by construction on the accept path: no session, no
 * stored snapshot, an unresolvable/invalid ref, or a node without a usable
 * rect all make the preflight a no-op and the fast path proceeds exactly as
 * before. Promotion to a hittable ancestor stays a runtime-path behavior —
 * the preflight never changes which element the backend acts on. Exception:
 * a would-be off-screen refusal may spend one extra iOS runner round trip
 * (#1542's double-check) before erroring — cost only on the path that was
 * about to fail anyway.
 *
 * Exported as an ADR 0011 registry anchor (interaction-guarantees.ts `via`
 * symbol, imported dynamically by the gate test); production callers reach
 * it through `dispatchNativeRefInteraction`.
 */
// fallow-ignore-next-line unused-export
export async function preflightNativeRefInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  action: InteractionAction,
): Promise<{
  targetHittable?: boolean;
  hint?: string;
  node?: SnapshotNode;
  preAction?: SurfaceScopedNodes;
}> {
  const session = await runtime.sessions.get(options.session ?? 'default');
  const storedSnapshot = session?.snapshot;
  const nodes = storedSnapshot?.nodes;
  if (!storedSnapshot || !nodes || normalizeRef(target.ref) === null) return {};
  const outcome = tryResolveRefNode(nodes, target.ref, {
    fallbackLabel: target.fallbackLabel ?? '',
  });
  if (outcome.kind !== 'resolved') return {};
  const { resolved } = outcome;
  // `resolvedTarget` whatever the command: its `none` promotion is what holds
  // ADR 0011's "the preflight never changes which element the backend acts on".
  const pipeline = SELECTOR_PIPELINE_POLICIES.resolvedTarget;
  // #1542: dispatches by REF, not coordinate, so no point is re-derived for the dispatch — but
  // evidence/annotation below still describes the returned (visible) node.
  const { node: visibleNode } = await runInteractionPipelineStages({
    policy: pipeline,
    nodes,
    node: resolved.node,
    action,
    label: `Ref ${target.ref}`,
    hooks: {
      offscreen: async (node, tree) =>
        await assertVisibleRefTarget(runtime, options, node, tree, target.ref, {
          action,
          pipeline,
        }),
    },
    resolveTapPoint: (node) => resolveRectCenter(node.rect),
  });
  return {
    ...describeNonHittableTarget(visibleNode, action),
    // ADR 0012 decision 3: the guard lookup above doubles as the record-time
    // evidence source for the fast path, at zero extra capture cost.
    node: visibleNode,
    preAction: surfaceScopedNodes(storedSnapshot),
  };
}

/**
 * ADR 0011 native-ref dispatch, shared by click/fill/hover @ref: run the
 * preflight guards against the stored node, hand the ref to the backend as
 * its own element handle, and return the exact-ref result envelope. Callers
 * decide WHEN the path applies (backend capability, no non-default options,
 * no replay guard, no settle baseline); this owns only the dispatch itself so
 * the three commands cannot drift on preflight or disclosure.
 */
export async function dispatchNativeRefInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  action: InteractionAction,
  dispatch: (
    context: BackendCommandContext,
    refTarget: BackendRefTarget,
  ) => Promise<BackendActionResult>,
): Promise<
  Extract<ResolvedInteractionTarget, { kind: 'ref' }> & { backendResult?: Record<string, unknown> }
> {
  const preflight = await preflightNativeRefInteraction(runtime, options, target, action);
  const backendResult = await dispatch(toBackendContext(runtime, options), {
    kind: 'ref',
    ref: target.ref,
    ...(target.fallbackLabel ? { fallbackLabel: target.fallbackLabel } : {}),
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'ref',
    target: { kind: 'ref', ref: target.ref },
    resolution: EXACT_REF_RESOLUTION,
    ...preflight,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
  };
}
