import type { CommandFlags } from '@agent-device/contracts/command';
import {
  readSnapshotOcclusionContextEvidence,
  snapshotCaptureAnnotationsFrom,
} from '@agent-device/contracts/capture';
import { isAndroidInputMethodNode } from '@agent-device/contracts/android-input-ownership';
import {
  attachRefs,
  buildSnapshotPresentationKey,
  snapshotPresentationOptionsFromFlags,
  type RawSnapshotNode,
  type SnapshotBackend,
  type SnapshotStateProvenance,
  snapshotStateProvenance,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import {
  annotateCoveredSnapshotNodes,
  annotateSnapshotNodesCoveredByPolicy,
} from '@agent-device/capture-kit/snapshot-occlusion';
import { coveredAndroidReplacementNodeIndexes } from '../snapshot/android-replacement-surface-occlusion.ts';
import { scopeSnapshotNodes } from '@agent-device/capture-kit/snapshot-desktop-projection';
import { normalizeSnapshotTree, pruneGroupNodes } from '../core/snapshot-tree-ingestion.ts';
import { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';
import { IOS_SNAPSHOT_PRODUCER_CAPABILITIES } from '@agent-device/capture-kit/ios-snapshot-planning';

/**
 * The ONE daemon assembly of a captured tree (ADR 0004 / #1797): normalize, group prune,
 * post-wire scope for backends that do not scope in their own projection, occlusion annotation,
 * refs. Every consumer of a captured tree — the
 * snapshot command, selector captures, settle observation, Android blocking-dialog recovery —
 * goes through here, so no two call sites can disagree about what a snapshot contains.
 *
 * Kept below the daemon-server type cycle on purpose: it needs no session state.
 */
export function buildSnapshotState(
  data: {
    nodes?: RawSnapshotNode[];
    truncated?: boolean;
    quality?: unknown;
  } & SnapshotStateProvenance,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): SnapshotState {
  const rawNodes = data?.nodes ?? [];
  const snapshotRaw = flags?.snapshotRaw;
  const backendAnnotatedNodes = annotateBackendReplacementSurfaces(
    data,
    rawNodes,
    snapshotRaw === true,
  );
  const normalizedNodes = normalizeSnapshotTree(
    snapshotRaw ? backendAnnotatedNodes : pruneGroupNodes(backendAnnotatedNodes),
  );
  const presentableNodes = shouldPresentIosInteractiveSnapshot(data, flags)
    ? presentIosInteractiveSnapshot(normalizedNodes)
    : normalizedNodes;
  const scopedNodes =
    flags?.snapshotScope && backendScopesAfterWire(data?.backend)
      ? scopeSnapshotNodes(presentableNodes, flags.snapshotScope)
      : presentableNodes;
  const snapshotQuality = snapshotCaptureAnnotationsFrom(data).quality;
  const nodes = attachRefs(
    snapshotRaw
      ? scopedNodes
      : annotateCoveredSnapshotNodes(scopedNodes, overlayOptionsForBackend(data?.backend)),
  );
  return {
    nodes,
    truncated: data?.truncated,
    createdAt: Date.now(),
    ...snapshotStateProvenance(data),
    ...(snapshotQuality ? { snapshotQuality } : {}),
    presentationKey: buildSnapshotPresentationKey(snapshotPresentationOptionsFromFlags(flags)),
    // Only broad Android snapshots become freshness baselines. If the user asked for a scoped
    // or filtered view, preserve that output contract but avoid pretending it is safe for
    // route-level comparisons on the next capture.
    comparisonSafe: isAndroidComparisonSafeSnapshot(data?.backend, flags),
  };
}

function annotateBackendReplacementSurfaces(
  owner: object & { backend?: SnapshotBackend },
  nodes: RawSnapshotNode[],
  raw: boolean,
): RawSnapshotNode[] {
  return owner.backend === 'android' && !raw
    ? annotateAndroidReplacementSurfaces(owner, nodes)
    : nodes;
}

function overlayOptionsForBackend(backend: SnapshotBackend | undefined) {
  return backend === 'android' ? { isAdditionalOverlayNode: isAndroidInputMethodNode } : {};
}

function annotateAndroidReplacementSurfaces(
  owner: object,
  nodes: RawSnapshotNode[],
): RawSnapshotNode[] {
  const context = readSnapshotOcclusionContextEvidence(owner);
  const coveredSourceIndexes = coveredAndroidReplacementNodeIndexes(
    context?.nodes ?? nodes,
    context?.androidSiblingOrderByNodeIndex,
  );
  return annotateSnapshotNodesCoveredByPolicy(nodes, (node) => {
    const sourceIndex = context?.sourceIndexByNodeIndex.get(node.index) ?? node.index;
    return coveredSourceIndexes.has(sourceIndex);
  });
}

/**
 * Scope resolves once per snapshot. Android and XCTest resolve it inside their projection (the
 * platform matchers implement the shared scope specification, `@agent-device/contracts/snapshot`),
 * and the macOS helper scopes at capture; a second pass here would re-match inside an already-scoped
 * tree and hand the two layers different no-match semantics (#1832 C2).
 */
function backendScopesAfterWire(backend: SnapshotBackend | undefined): boolean {
  return backend !== 'macos-helper' && backend !== 'android' && backend !== 'xctest';
}

function shouldPresentIosInteractiveSnapshot(
  provenance: SnapshotStateProvenance,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): boolean {
  return (
    provenance.backend === 'xctest' &&
    iosSnapshotPresentationStage(provenance) === 'acquired' &&
    flags?.snapshotInteractiveOnly === true &&
    flags.snapshotRaw !== true
  );
}

function iosSnapshotPresentationStage(
  provenance: SnapshotStateProvenance,
): 'acquired' | 'presented' | undefined {
  if (provenance.backend !== 'xctest') return undefined;
  if (provenance.producer === undefined) return 'acquired';
  return IOS_SNAPSHOT_PRODUCER_CAPABILITIES[
    provenance.producer as 'apple-runner' | 'appium-source' | 'limrun-ios-tree'
  ].stage;
}

function isAndroidComparisonSafeSnapshot(
  backend: SnapshotBackend | undefined,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): boolean {
  return (
    backend === 'android' &&
    flags?.snapshotInteractiveOnly !== true &&
    typeof flags?.snapshotDepth !== 'number' &&
    !flags?.snapshotScope
  );
}
