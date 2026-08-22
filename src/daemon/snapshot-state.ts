import type { CommandFlags } from '@agent-device/contracts/command';
import { snapshotCaptureAnnotationsFrom } from '@agent-device/contracts/capture';
import { isAndroidInputMethodNode } from '@agent-device/contracts/android-input-ownership';
import {
  attachRefs,
  buildSnapshotPresentationKey,
  snapshotPresentationOptionsFromFlags,
  type RawSnapshotNode,
  type SnapshotBackend,
  type SnapshotState,
} from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from '../snapshot/snapshot-occlusion.ts';
import { scopeSnapshotNodes } from '../snapshot/snapshot-desktop-surface.ts';
import { normalizeSnapshotTree, pruneGroupNodes } from '../core/snapshot-tree-ingestion.ts';
import { presentIosInteractiveSnapshot } from './snapshot-presentation/ios/index.ts';

/**
 * The ONE daemon presentation of a captured tree (ADR 0004 / #1797 "compaction layer"): normalize,
 * group prune, iOS interactive presentation, post-wire scope for backends that do not scope in
 * their own projection, occlusion annotation, refs. Every consumer of a captured tree — the
 * snapshot command, selector captures, settle observation, Android blocking-dialog recovery —
 * goes through here, so no two call sites can disagree about what a snapshot contains.
 *
 * Kept below the daemon-server type cycle on purpose: it needs no session state.
 */
export function buildSnapshotState(
  data: {
    nodes?: RawSnapshotNode[];
    truncated?: boolean;
    backend?: SnapshotBackend;
    quality?: unknown;
  },
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): SnapshotState {
  const rawNodes = data?.nodes ?? [];
  const snapshotRaw = flags?.snapshotRaw;
  const normalizedNodes = normalizeSnapshotTree(snapshotRaw ? rawNodes : pruneGroupNodes(rawNodes));
  const presentableNodes = shouldPresentIosInteractiveSnapshot(data?.backend, flags)
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
      : annotateCoveredSnapshotNodes(scopedNodes, {
          isAdditionalOverlayNode:
            data?.backend === 'android' ? isAndroidInputMethodNode : undefined,
        }),
  );
  return {
    nodes,
    truncated: data?.truncated,
    createdAt: Date.now(),
    backend: data?.backend,
    ...(snapshotQuality ? { snapshotQuality } : {}),
    presentationKey: buildSnapshotPresentationKey(snapshotPresentationOptionsFromFlags(flags)),
    // Only broad Android snapshots become freshness baselines. If the user asked for a scoped
    // or filtered view, preserve that output contract but avoid pretending it is safe for
    // route-level comparisons on the next capture.
    comparisonSafe: isAndroidComparisonSafeSnapshot(data?.backend, flags),
  };
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
  backend: SnapshotBackend | undefined,
  flags:
    | (Pick<CommandFlags, 'snapshotDepth' | 'snapshotInteractiveOnly' | 'snapshotRaw'> &
        Partial<Pick<CommandFlags, 'snapshotScope'>>)
    | undefined,
): boolean {
  return (
    backend === 'xctest' && flags?.snapshotInteractiveOnly === true && flags.snapshotRaw !== true
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
