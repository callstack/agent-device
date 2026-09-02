import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type {
  IosAcquisitionResidue,
  IosProviderAcquisitionProducer,
  IosSnapshotProducer,
  IosSnapshotProducerCapabilities,
  IosSnapshotLineage,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

const ACQUIRED_PRODUCER_CAPABILITY_DEFAULTS = {
  stage: 'acquired',
  acquisitionDepth: {
    rawTraversal: { kind: 'incomplete' },
    regularPresented: { kind: 'incomplete' },
  },
  scopeCompleteness: 'incomplete',
  interactiveQueryCompleteness: 'incomplete',
  viewportEvidence: 'available',
  hittabilityEvidence: 'unavailable',
  truncationEvidence: 'unavailable',
  presentationOwner: 'ios-snapshot-engine',
} as const;

const IOS_SNAPSHOT_PRODUCER_CAPABILITY_VALUES = {
  'apple-runner': {
    producer: 'apple-runner',
    stage: 'presented',
    acquisitionDepth: {
      rawTraversal: { kind: 'not-applicable' },
      regularPresented: { kind: 'not-applicable' },
    },
    scopeCompleteness: 'complete',
    interactiveQueryCompleteness: 'complete',
    viewportEvidence: 'available',
    hittabilityEvidence: 'available',
    truncationEvidence: 'available',
    presentationOwner: 'ios-snapshot-engine',
  },
  'simulator-ax-bridge': {
    ...ACQUIRED_PRODUCER_CAPABILITY_DEFAULTS,
    producer: 'simulator-ax-bridge',
    acquisitionDepth: {
      rawTraversal: { kind: 'complete' },
      regularPresented: { kind: 'incomplete' },
    },
    hittabilityEvidence: 'available',
    truncationEvidence: 'available',
    presentationOwner: 'snapshot-state',
  },
  'appium-source': {
    ...ACQUIRED_PRODUCER_CAPABILITY_DEFAULTS,
    producer: 'appium-source',
  },
  'limrun-ios-tree': {
    ...ACQUIRED_PRODUCER_CAPABILITY_DEFAULTS,
    producer: 'limrun-ios-tree',
  },
} as const satisfies Record<IosSnapshotProducer, IosSnapshotProducerCapabilities>;

export const IOS_SNAPSHOT_PRODUCER_CAPABILITIES: Readonly<
  Record<IosSnapshotProducer, IosSnapshotProducerCapabilities>
> = Object.freeze(IOS_SNAPSHOT_PRODUCER_CAPABILITY_VALUES);

function deriveIosSnapshotAcquisitionResidue(
  producer: IosSnapshotProducerCapabilities,
  viewport: IosViewportEvidence,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [];
  if (producer.hittabilityEvidence === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'hittability' });
  }
  if (
    producer.stage === 'acquired' &&
    (producer.acquisitionDepth.rawTraversal.kind === 'incomplete' ||
      producer.acquisitionDepth.regularPresented.kind === 'incomplete')
  ) {
    residue.push({ kind: 'unavailable-fact', fact: 'acquisition-depth' });
  }
  if (producer.truncationEvidence === 'unavailable') {
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
  const producer = IOS_SNAPSHOT_PRODUCER_CAPABILITIES[input.producer];
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
