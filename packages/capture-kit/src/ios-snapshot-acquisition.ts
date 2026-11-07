import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type {
  IosAcquisitionResidue,
  IosCollapsedTabBarProbeFailure,
  IosProviderAcquisitionProducer,
  IosSnapshotLineage,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import { normalizeType, SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type {
  RawSnapshotNode,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';

/**
 * What a provider-derived producer leaves unproven: it hands over a bare tree, so it reports neither
 * traversal depth nor hittability, and truncation only when its registry row says it observes it.
 * `apple-runner` and `simulator-ax-bridge` build their own residue at the source (the bridge reader
 * derives geometric `hittable` and emits `unavailable-fact: hittability` only when the viewport is
 * missing), which is why {@link IosProviderAcquisitionProducer} admits neither (#2199).
 */
function deriveIosSnapshotAcquisitionResidue(
  producer: IosProviderAcquisitionProducer,
  viewport: IosViewportEvidence,
  collapsedTabBarProbeFailure: IosCollapsedTabBarProbeFailure | undefined,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [
    { kind: 'unavailable-fact', fact: 'hittability' },
    { kind: 'unavailable-fact', fact: 'acquisition-depth' },
  ];
  if (SNAPSHOT_PRODUCERS[producer].truncation === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'truncation' });
  }
  if (viewport.kind === 'missing') {
    residue.push({ kind: 'missing-viewport', reason: viewport.reason });
  }
  if (collapsedTabBarProbeFailure) {
    residue.push({ kind: 'collapsed-tab-bar-probe-failed', reason: collapsedTabBarProbeFailure });
  }
  return Object.freeze(residue);
}

export function createIosSnapshotAcquisition(
  input: Readonly<{
    producer: IosProviderAcquisitionProducer;
    nodes: readonly RawSnapshotNode[];
    viewport: IosViewportEvidence;
    keyboard?: SnapshotKeyboardBandFact;
    lineage: IosSnapshotLineage;
    /**
     * Set when the provider left a collapsed tab bar unexpanded: a hit-test was rejected or timed
     * out, or the hit-test budget ran out before a candidate with a tab bar's height was checked.
     */
    collapsedTabBarProbeFailure?: IosCollapsedTabBarProbeFailure;
  }>,
): SnapshotRuntimeAcquiredResult {
  return {
    stage: 'acquired',
    acquisition: {
      producer: input.producer,
      intent: 'full',
      nodes: input.nodes,
      viewport: input.viewport,
      ...(input.keyboard ? { keyboard: input.keyboard } : {}),
      lineage: input.lineage,
      residue: deriveIosSnapshotAcquisitionResidue(
        input.producer,
        input.viewport,
        input.collapsedTabBarProbeFailure,
      ),
    },
  };
}

type IosSnapshotViewportRoot = Readonly<{
  type?: string;
  rect?: Rect;
  rectStatus?: 'reported' | 'invalid' | 'not-provided';
}>;

export function resolveIosViewportEvidenceFromRoots(
  roots: readonly IosSnapshotViewportRoot[],
  options: Readonly<{ fallbackToLargestRoot?: boolean }> = {},
): IosViewportEvidence | undefined {
  const viewportRoots = roots.filter(isViewportRoot);
  const candidates =
    viewportRoots.length > 0 || options.fallbackToLargestRoot !== true ? viewportRoots : roots;
  const root = [...candidates].sort(compareViewportRoots)[0];
  if (!root) return undefined;
  if (isPositiveFiniteRect(root.rect)) return { kind: 'reported', rect: root.rect };
  return {
    kind: 'missing',
    reason:
      root.rectStatus === 'invalid' || (root.rectStatus === undefined && root.rect !== undefined)
        ? 'invalid'
        : 'not-provided',
  };
}

function isViewportRoot(root: IosSnapshotViewportRoot): boolean {
  const type = normalizeType(root.type ?? '');
  return type === 'application' || type === 'window';
}

function compareViewportRoots(
  left: IosSnapshotViewportRoot,
  right: IosSnapshotViewportRoot,
): number {
  const status = rootGeometryRank(right.rectStatus) - rootGeometryRank(left.rectStatus);
  return status || rectArea(right.rect) - rectArea(left.rect);
}

function rootGeometryRank(status: IosSnapshotViewportRoot['rectStatus']): number {
  return status === 'reported' ? 2 : status === 'invalid' ? 1 : 0;
}

function rectArea(rect: Rect | undefined): number {
  return rect && isPositiveFiniteRect(rect) ? rect.width * rect.height : 0;
}
