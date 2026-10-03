import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import { type SelectorResolution, buildSelectorChainForNode } from '@agent-device/selectors';
import { resolvePressRecordingTarget } from '@agent-device/selectors/press-retarget';
import { resolveRefLabel } from '@agent-device/capture-kit/snapshot-node-lookup';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { truncateUtf8 } from './truncate-utf8.ts';
import type {
  RecordingTargetOverride,
  ResolutionDiagnosticEntry,
  ResolutionDisclosure,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import type { InteractionAction } from './interaction-resolution-request.ts';

export type ResolvedRefNode = {
  ref: string;
  node: SnapshotNode;
  resolution: ResolutionDisclosure;
};

// ADR 0012 decision 2 bounds: diagnostic strings and losing alternatives.
const RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP = 256;
const MAX_RESOLUTION_ALTERNATIVES = 5;

/**
 * A successful `@ref` lookup names exactly one node; label recovery discloses label-fallback instead.
 * ADR 0011 registry anchor: interaction-guarantees.ts cites it as a `via` symbol.
 */
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

/** Shared construction site for every runtime-ref resolution disclosure. */
export function buildRefResolution(
  ref: string,
  node: SnapshotNode,
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
  resolved: SelectorResolution,
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
  node: SnapshotNode,
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
  node: SnapshotNode,
  tree: SurfaceScopedNodes,
  action: InteractionAction,
  resolution: ResolutionDisclosure,
): {
  node: SnapshotNode;
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

/**
 * iOS AX `hittable` flags are unreliable on deep React Native trees (see #1037:
 * a map-pin annotation exact-matched a longer recents row label and reported tap
 * success while doing nothing visible). We deliberately do NOT fail or filter on
 * this signal — that would break selectors that only ever resolve to nodes the
 * platform marks non-hittable. Instead, surface it so the caller can notice a
 * likely no-op tap and re-target with a ref or a more specific selector/longer text.
 */
export function describeNonHittableTarget(
  node: SnapshotNode,
  action: InteractionAction,
): { targetHittable?: boolean; hint?: string } {
  if (node.hittable !== false) return {};
  return {
    targetHittable: false,
    hint: `The resolved element reports hittable: false, so this ${action} may have had no visible effect. Verify with a snapshot, or prefer a @ref or a longer/more specific selector to target the intended element.`,
  };
}
