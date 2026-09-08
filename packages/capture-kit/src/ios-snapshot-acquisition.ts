import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type {
  IosAcquisitionResidue,
  IosProviderAcquisitionCapabilities,
  IosProviderAcquisitionProducer,
  IosSnapshotEvidenceAvailability,
  IosSnapshotLineage,
  IosSnapshotProducer,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

/**
 * The facts a *provider* acquisition leaves unproven, keyed only by the producers whose residue
 * this module derives.
 *
 * `apple-runner` and `simulator-ax-bridge` are absent by construction, not by omission: each
 * builds its own residue at the source (the bridge adapter emits `unavailable-fact: hittability`
 * on every capture; the runner presents and reports its own facts), so a row here would be a
 * declaration with no reader — which is how the table came to claim the bridge had hittability
 * evidence while every bridge-served `snapshot -i` printed the opposite (#2199). Keying the
 * record on {@link IosProviderAcquisitionProducer} makes that claim not compile.
 */
const IOS_PROVIDER_ACQUISITION_CAPABILITY_VALUES = {
  'appium-source': {
    producer: 'appium-source',
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
    hittabilityEvidence: 'unavailable',
  },
  'limrun-ios-tree': {
    producer: 'limrun-ios-tree',
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
    hittabilityEvidence: 'unavailable',
  },
} as const satisfies Record<IosProviderAcquisitionProducer, IosProviderAcquisitionCapabilities>;

/**
 * Whether a producer observes truncation at all, for every iOS producer.
 *
 * This is the one capability the runner and the bridge genuinely need declared: a capture that
 * reported nothing about truncation is only "not truncated" when its producer would have noticed
 * (#2188 invariant 5), and `snapshotTruncationForResult` has to answer that for all four. It is a
 * table of its own rather than a column of the provider capabilities so that each producer states
 * this fact exactly once, in the only place that asks.
 *
 * The runner payload carries a required `truncated` boolean, and the bridge adapter rejects an
 * envelope without one and turns a true into a `truncated` residue — so both observe it.
 */
const IOS_SNAPSHOT_TRUNCATION_EVIDENCE = {
  'apple-runner': 'available',
  'simulator-ax-bridge': 'available',
  'appium-source': 'unavailable',
  'limrun-ios-tree': 'unavailable',
} as const satisfies Record<IosSnapshotProducer, IosSnapshotEvidenceAvailability>;

export function iosSnapshotTruncationEvidence(
  producer: IosSnapshotProducer,
): IosSnapshotEvidenceAvailability {
  return IOS_SNAPSHOT_TRUNCATION_EVIDENCE[producer];
}

function deriveIosSnapshotAcquisitionResidue(
  producer: IosProviderAcquisitionCapabilities,
  viewport: IosViewportEvidence,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [];
  if (producer.hittabilityEvidence === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'hittability' });
  }
  if (
    producer.acquisitionDepth.rawTraversal.kind === 'incomplete' ||
    producer.acquisitionDepth.regularPresented.kind === 'incomplete'
  ) {
    residue.push({ kind: 'unavailable-fact', fact: 'acquisition-depth' });
  }
  if (iosSnapshotTruncationEvidence(producer.producer) === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'truncation' });
  }
  if (viewport.kind === 'missing') {
    residue.push({ kind: 'missing-viewport', reason: viewport.reason });
  }
  return Object.freeze(residue);
}

export function createIosSnapshotAcquisition(
  input: Readonly<{
    producer: IosProviderAcquisitionProducer;
    nodes: readonly RawSnapshotNode[];
    viewport: IosViewportEvidence;
    lineage: IosSnapshotLineage;
  }>,
): SnapshotRuntimeAcquiredResult {
  const producer = IOS_PROVIDER_ACQUISITION_CAPABILITY_VALUES[input.producer];
  return {
    stage: 'acquired',
    acquisition: {
      producer: input.producer,
      intent: 'full',
      nodes: input.nodes,
      viewport: input.viewport,
      lineage: input.lineage,
      residue: deriveIosSnapshotAcquisitionResidue(producer, input.viewport),
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
