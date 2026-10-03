import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type {
  SnapshotKeyboardBandFact,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { findNodeByRef, normalizeRef } from '@agent-device/kernel/snapshot';
import { resolveRectCenter } from '@agent-device/kernel/rect-center';
import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '../../../runtime-contract.ts';
import { STALE_REF_HINT } from '@agent-device/selectors';
import type { InteractionSnapshot } from './interaction-snapshot-capture.ts';
import { requireSnapshotSession } from './selector-read-shared.ts';
import { findNodeByLabel } from '@agent-device/capture-kit/snapshot-node-lookup';
import { surfaceScopedNodes } from './post-action-surface.ts';
import type {
  InteractionTarget,
  PreresolvedInteractionTarget,
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { localIdentitiesEqual, readNodeLocalIdentity } from '@agent-device/ad-script';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';
import { assertReplayTargetResolution } from './replay-target-guard.ts';
import {
  buildRefResolution,
  describeResolvedInteractionNode,
  type ResolvedRefNode,
} from './resolution-disclosure.ts';
import {
  assertVisibleRefTarget,
  runInteractionPipelineStages,
} from './target-visibility-stages.ts';
import { resolveNodeTouchPoint } from './resolution-touch-point.ts';

/** The node a ref target acts on, plus the tree the shared guards read it against. */
type RefResolution = {
  tree: SurfaceScopedNodes;
  resolved: ResolvedRefNode;
  /** The keyboard band the capture of `tree.nodes` measured, when it measured one (#2660). */
  keyboard?: SnapshotKeyboardBandFact;
};

/**
 * #1654: adopt the node the caller already resolved instead of resolving the
 * same `@ref` a second time. This replaces the LOOKUP only — every guard below
 * still runs, against the caller's tree, at the symbols the ADR 0011
 * `runtime-ref` cells name.
 *
 * `exact` is truthful only when all three pieces of carried provenance agree:
 * the positional ref, the payload ref, and the node's own ref. Fail closed if
 * future internal plumbing lets them drift.
 */
function adoptPreresolvedRefTarget(
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  preresolved: PreresolvedInteractionTarget,
): RefResolution {
  const ref = normalizeRef(target.ref);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${target.ref}`);
  const carriedRef = normalizeRef(preresolved.ref);
  const nodeRef = preresolved.node.ref ? normalizeRef(preresolved.node.ref) : null;
  if (carriedRef !== ref || nodeRef !== ref || !preresolved.nodes.includes(preresolved.node)) {
    throw new AppError(
      'COMMAND_FAILED',
      'Internal find target provenance does not match the interaction ref',
    );
  }
  return {
    tree: {
      nodes: preresolved.nodes,
      ...(preresolved.iosSystemSurfaceBundleId
        ? { surfaceBundleId: preresolved.iosSystemSurfaceBundleId }
        : {}),
    },
    ...(preresolved.keyboard ? { keyboard: preresolved.keyboard } : {}),
    resolved: buildRefResolution(ref, preresolved.node, 'exact'),
  };
}

async function readRefResolution(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
): Promise<RefResolution> {
  const capture = await resolveSnapshotForRef(runtime, options, target);
  return {
    tree: surfaceScopedNodes(capture.snapshot),
    ...(capture.snapshot.keyboard ? { keyboard: capture.snapshot.keyboard } : {}),
    resolved: capture.resolved,
  };
}

export async function resolveRefInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const { tree, keyboard, resolved } = params.preresolvedTarget
    ? adoptPreresolvedRefTarget(target, params.preresolvedTarget)
    : await readRefResolution(runtime, options, target);
  const nodes = tree.nodes;
  // #1542: point/response read from the returned (possibly rescue-patched) node.
  const { node: visibleNode, tapPoint: point } = await runInteractionPipelineStages({
    policy: params.pipeline,
    nodes,
    ...(keyboard ? { keyboard } : {}),
    node: resolved.node,
    action: params.action,
    label: `Ref ${target.ref}`,
    hooks: {
      onResolved: (node, tree) => assertReplayTargetResolution(node, tree, params),
      offscreen: async (node, tree) =>
        await assertVisibleRefTarget(runtime, options, node, tree, target.ref, params),
    },
    resolveTapPoint: (node) =>
      resolveNodeTouchPoint(node, nodes, {
        invalidMessage: `Ref ${target.ref} has no usable bounds`,
        blockedTargetLabel: `Ref ${target.ref}`,
        blockedTargetDetails: { ref: `@${normalizeRef(target.ref) ?? node.ref}` },
      }),
  });
  return {
    kind: 'ref',
    point,
    target: { kind: 'ref', ref: `@${resolved.ref}` },
    ...describeResolvedInteractionNode(
      runtime,
      visibleNode,
      tree,
      params.action,
      resolved.resolution,
    ),
  };
}

async function resolveSnapshotForRef(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
): Promise<InteractionSnapshot & { resolved: ResolvedRefNode }> {
  const { session, snapshot: frameTree } = await requireSnapshotSession(runtime, options.session);

  const fallbackLabel = target.fallbackLabel ?? '';
  const outcome = tryResolveRefNode(frameTree.nodes, target.ref, {
    fallbackLabel,
  });
  // ADR 0014: missing authorized-frame evidence FAILS. It must not fall through
  // to a fresh capture and accept the same ref body from a newer tree — that is
  // exactly the positional-coincidence retarget the frame model forbids. A stale
  // read is observable and recoverable; a stale mutation can act on the wrong
  // element. The caller re-observes (snapshot) or uses a selector.
  if (outcome.kind !== 'resolved') throw refMissRefusal(outcome, target.ref);
  return reconcileFreshObservation({
    session,
    frameTree,
    target,
    fallbackLabel,
    authorized: outcome.resolved,
  });
}

/**
 * ADR 0014 step 5: decouple Android freshness from ref authorization. The frame
 * tree names WHICH node `@eN` authorizes. When a freshness (or other read-only)
 * capture has advanced the operational observation past the frame, adopt the
 * observation's node — its fresh on-screen coordinates — ONLY when its local
 * identity still matches the authorized node. That covers the legitimate case of
 * an element that merely moved. If the identity differs (a different element now
 * sits at that index) or the ref is absent from the observation, keep the
 * authorized frame node so a positional coincidence cannot retarget the action.
 */
function reconcileFreshObservation(params: {
  session: CommandSessionRecord;
  frameTree: SnapshotState;
  target: Extract<InteractionTarget, { kind: 'ref' }>;
  fallbackLabel: string;
  authorized: ResolvedRefNode;
}): InteractionSnapshot & { resolved: ResolvedRefNode } {
  const { session, frameTree, target, fallbackLabel, authorized } = params;
  const observation = session.snapshot;
  if (!observation || observation === frameTree) {
    return { snapshot: frameTree, resolved: authorized };
  }
  const observed = tryResolveRefNode(observation.nodes, target.ref, { fallbackLabel });
  if (
    observed.kind === 'resolved' &&
    localIdentitiesEqual(
      readNodeLocalIdentity(authorized.node),
      readNodeLocalIdentity(observed.resolved.node),
    )
  ) {
    return { snapshot: observation, resolved: observed.resolved };
  }
  return { snapshot: frameTree, resolved: authorized };
}

/** The runtime-ref resolver: `exact` for a resolved `@ref`, `label-fallback` for trailing-label recovery. */
/**
 * What one tree makes of a ref: the node it authorizes (exact, or the trailing-label recovery), a
 * node it lists (by ref or by that label) that has no usable centre, or no node at all. The two
 * misses are distinct outcomes so a caller can name a stale ref and an unactionable target apart.
 */
export type RefResolutionOutcome =
  | { kind: 'resolved'; resolved: ResolvedRefNode }
  | { kind: 'unusable'; node: SnapshotNode }
  | { kind: 'missing' };

export function tryResolveRefNode(
  nodes: SnapshotState['nodes'],
  refInput: string,
  options: {
    fallbackLabel: string;
  },
): RefResolutionOutcome {
  const ref = normalizeRef(refInput);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${refInput}`);
  const refNode = findNodeByRef(nodes, ref);
  if (isUsableResolvedNode(refNode)) {
    return { kind: 'resolved', resolved: buildRefResolution(ref, refNode, 'exact') };
  }
  const fallbackNode =
    options.fallbackLabel.length > 0 ? findNodeByLabel(nodes, options.fallbackLabel) : null;
  if (isUsableResolvedNode(fallbackNode)) {
    return { kind: 'resolved', resolved: buildRefResolution(ref, fallbackNode, 'label-fallback') };
  }
  const found = refNode ?? fallbackNode;
  return found ? { kind: 'unusable', node: found } : { kind: 'missing' };
}

/**
 * The refusal for a ref the frame could not authorize: a ref no node carries is stale or was never
 * issued (`ref_not_found`); a ref whose node is listed but has no usable centre is present and
 * unactionable (`target_bounds_invalid`). Both recover the same way, a fresh observation, so both
 * carry the stale-ref hint; `details.ref` is the bare ref body either way.
 */
function refMissRefusal(
  miss: Exclude<RefResolutionOutcome, { kind: 'resolved' }>,
  refInput: string,
): AppError {
  const ref = normalizeRef(refInput) ?? refInput;
  const refusal =
    miss.kind === 'unusable'
      ? new AppError('COMMAND_FAILED', `Ref ${refInput} has no usable bounds`, {
          reason: INTERACTION_ERROR_REASONS.targetBoundsInvalid,
          ref,
          hint: STALE_REF_HINT,
        })
      : new AppError('COMMAND_FAILED', `Ref ${refInput} not found`, {
          reason: INTERACTION_ERROR_REASONS.refNotFound,
          ref,
          hint: STALE_REF_HINT,
        });
  return discloseDispatch(refusal, 'no');
}

function isUsableResolvedNode(node: SnapshotNode | null | undefined): node is SnapshotNode {
  if (!node) return false;
  return resolveRectCenter(node.rect) !== null;
}
