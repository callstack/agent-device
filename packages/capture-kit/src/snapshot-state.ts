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
  type SnapshotCaptureProvenance,
  snapshotStateProvenance,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import {
  annotateCoveredSnapshotNodes,
  annotateSnapshotNodesCoveredByPolicy,
} from './snapshot-occlusion.ts';
import { coveredAndroidReplacementNodeIndexes } from './snapshot/android-replacement-surface-occlusion.ts';
import { scopeSnapshotNodes } from './snapshot-desktop-projection.ts';
import { normalizeSnapshotTree, pruneGroupNodes } from './snapshot-tree-ingestion.ts';
import { iosSnapshotComparisonIdentityKey } from './ios-snapshot-planning.ts';
import type { IosSnapshotComparisonIdentity } from '@agent-device/contracts/ios-snapshot';

/**
 * The ONE daemon assembly of a captured tree (ADR 0004 / #1797): normalize, group prune,
 * post-wire scope for backends that do not scope in their own projection, occlusion annotation,
 * refs. Every consumer of a captured tree — the
 * snapshot command, selector captures, settle observation, Android blocking-dialog recovery —
 * goes through here, so no two call sites can disagree about what a snapshot contains.
 *
 * The assembly does not present. iOS acquisitions are presented exactly once, by the snapshot
 * engine, before they reach here (#2199 / #2188 invariant 2), and a capture arrives with its
 * whole provenance pair so no branch here can rediscover who presented it.
 *
 * Kept below the daemon-server type cycle on purpose: it needs no session state.
 */
export function buildSnapshotState(
  data: {
    nodes?: RawSnapshotNode[];
    truncated?: boolean;
    quality?: unknown;
    comparisonIdentity?: IosSnapshotComparisonIdentity;
  } & SnapshotCaptureProvenance,
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
  const scopedNodes =
    flags?.snapshotScope && backendScopesAfterWire(data?.backend)
      ? scopeSnapshotNodes(normalizedNodes, flags.snapshotScope)
      : normalizedNodes;
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
    ...(data.comparisonIdentity
      ? { comparisonKey: iosSnapshotComparisonIdentityKey(data.comparisonIdentity) }
      : {}),
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
 * Scope resolves once per snapshot, and this names the channels that still need the post-wire
 * pass. Every other channel scopes inside its own projection — Android and the macOS helper at
 * capture, iOS in the snapshot engine — and a second pass would re-match inside an already-scoped
 * tree and hand the two layers different no-match semantics (#1832 C2). Naming the channels that
 * need the pass rather than the ones that do not keeps iOS out of post-wire scope planning
 * entirely, so the list shrinks as a channel takes ownership instead of growing by exclusion
 * (#2199).
 */
function backendScopesAfterWire(backend: SnapshotBackend | undefined): boolean {
  return (
    backend === undefined ||
    backend === 'linux-atspi' ||
    backend === 'harmonyos-arkui' ||
    backend === 'web'
  );
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
