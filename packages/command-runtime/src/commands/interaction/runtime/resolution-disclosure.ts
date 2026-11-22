import type { SnapshotAddressableNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';
import { buildSelectorChainForNode } from '@agent-device/selectors';
import { resolvePressRecordingTarget } from '@agent-device/selectors/press-retarget';
import { describeNonHittableTarget } from '@agent-device/selectors/interaction-targeting';
import { resolveRefLabel } from '@agent-device/capture-kit/snapshot-node-lookup';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { truncateUtf8 } from './truncate-utf8.ts';
import type { ActionSelectorResolution } from './selector-action-resolution.ts';
import type {
  RecordingTargetOverride,
  ResolutionDiagnosticEntry,
  ResolutionDisclosure,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import type { InteractionAction } from '@agent-device/selectors/interaction-action';

export type ResolvedRefNode = {
  ref: string;
  node: SnapshotAddressableNode;
  resolution: ResolutionDisclosure;
};

// ADR 0012 decision 2 bounds: diagnostic strings and losing alternatives.
const RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP = 256;
const MAX_RESOLUTION_ALTERNATIVES = 5;

/** A successful `@ref` lookup names exactly one node; label recovery discloses label-fallback instead. */
export const EXACT_REF_RESOLUTION: ResolutionDisclosure = {
  source: 'ref',
  phase: 'pre-action',
  kind: 'exact',
};

const LABEL_FALLBACK_REF_RESOLUTION: ResolutionDisclosure = {
  source: 'ref',
  phase: 'pre-action',
  kind: 'label-fallback',
};

/** Shared construction site for every runtime-ref and native-ref preflight resolution disclosure. */
export function buildRefResolution(
  ref: string,
  node: SnapshotAddressableNode,
  kind: 'exact' | 'label-fallback',
): ResolvedRefNode {
  return {
    ref,
    node,
    resolution: kind === 'exact' ? EXACT_REF_RESOLUTION : LABEL_FALLBACK_REF_RESOLUTION,
  };
}

const UNIQUE_RUNTIME_RESOLUTION: ResolutionDisclosure = {
  source: 'runtime',
  phase: 'pre-action',
  kind: 'unique',
};

// Disclosure only: the winner stays resolveSelectorChain's pick (ADR 0012).
export function buildSelectorResolutionDisclosure(
  resolved: ActionSelectorResolution,
  nodes: SnapshotState['nodes'],
): ResolutionDisclosure {
  if (!resolved.disambiguation) return UNIQUE_RUNTIME_RESOLUTION;
  return {
    source: 'runtime',
    phase: 'pre-action',
    kind: 'disambiguated',
    matchCount: resolved.disambiguation.matchCount,
    winnerDiagnostic: buildResolutionDiagnosticEntry(resolved.node, nodes),
    tiebreak: resolved.disambiguation.tiebreak,
    alternatives: resolved.disambiguation.alternatives
      .slice(0, MAX_RESOLUTION_ALTERNATIVES)
      .map((node) => buildResolutionDiagnosticEntry(node, nodes)),
  };
}

function buildResolutionDiagnosticEntry(
  node: SnapshotAddressableNode,
  nodes: SnapshotState['nodes'],
): ResolutionDiagnosticEntry {
  const role = normalizeType(node.type ?? '');
  const label = resolveRefLabel(node, nodes);
  return {
    diagnosticRef: `diag-${node.ref}`,
    ...(role ? { role: truncateUtf8(role, RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP) } : {}),
    ...(label !== undefined
      ? { label: truncateUtf8(label, RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP) }
      : {}),
  };
}

// Shared tail of a resolved ref/selector interaction target: the node itself
// plus everything derived from it for the response. Every response field
// describes the DISPATCHED node — the #1280 retarget rides only on the
// `recordingTarget` side channel below. `tree` is the capture the node was
// resolved from, and becomes the pre-action baseline this publishes.
export function describeResolvedInteractionNode(
  runtime: AgentDeviceRuntime,
  node: SnapshotAddressableNode,
  tree: SurfaceScopedNodes,
  action: InteractionAction,
  resolution: ResolutionDisclosure,
): {
  node: SnapshotAddressableNode;
  selectorChain: string[];
  refLabel: string | undefined;
  targetHittable?: boolean;
  hint?: string;
  preAction: SurfaceScopedNodes;
  resolution: ResolutionDisclosure;
  recordingTarget?: RecordingTargetOverride;
} {
  const nodes = tree.nodes;
  return {
    node,
    selectorChain: buildSelectorChainForNode(node, runtime.backend.platform, {
      action: action === 'fill' ? 'fill' : 'click',
      nodes,
    }),
    refLabel: resolveRefLabel(node, nodes),
    ...describeNonHittableTarget(node, action),
    preAction: tree,
    resolution,
    ...pressRecordingTargetOverride(runtime, node, nodes, action),
  };
}

/**
 * #1280 (ADR 0012 decision 3 amendment): the recording-only side channel.
 * When a click/press resolves to an identity-empty container, the RECORDED
 * step retargets to its first labeled descendant — node, chain, and
 * ref-label computed together here so the recorded action entry and its
 * `target-v1` evidence can never half-retarget. The response payloads never
 * consume this (see `interaction-touch-response.ts`). `fill` is deliberately
 * excluded: its chain carries `editable=true` constraints a label descendant
 * cannot satisfy, which would record an unreplayable selector.
 */
function pressRecordingTargetOverride(
  runtime: AgentDeviceRuntime,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  action: InteractionAction,
): { recordingTarget?: RecordingTargetOverride } {
  if (action !== 'click' && action !== 'press') return {};
  const recordingNode = resolvePressRecordingTarget(node, nodes);
  if (recordingNode === node) return {};
  return {
    recordingTarget: {
      node: recordingNode,
      selectorChain: buildSelectorChainForNode(recordingNode, runtime.backend.platform, {
        action: 'click',
        nodes,
      }),
      refLabel: resolveRefLabel(recordingNode, nodes),
    },
  };
}
