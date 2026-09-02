import {
  resolveIosViewportEvidenceFromRoots,
  type IosSnapshotViewportRoot,
} from '@agent-device/capture-kit/ios-snapshot-engine';
import {
  deriveIosSnapshotAcquisitionResidue,
  IOS_SNAPSHOT_PRODUCER_CAPABILITIES,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { LimrunIosSession } from './ios.ts';
import { flattenIosTree, type IosTreeNode } from './snapshot.ts';

const LIMRUN_IOS_PRODUCER = IOS_SNAPSHOT_PRODUCER_CAPABILITIES['limrun-ios-tree'];

export async function captureLimrunIosSnapshot(
  session: Pick<LimrunIosSession, 'client' | 'instanceId'>,
): Promise<SnapshotRuntimeAcquiredResult> {
  const tree = JSON.parse(await session.client.elementTree()) as IosTreeNode | IosTreeNode[];
  const viewport = readLimrunViewport(tree, session.client.deviceInfo);
  return {
    stage: 'acquired',
    acquisition: {
      producer: 'limrun-ios-tree',
      intent: 'full',
      nodes: flattenIosTree(tree),
      viewport,
      lineage: { targetId: session.instanceId },
      residue: deriveIosSnapshotAcquisitionResidue(LIMRUN_IOS_PRODUCER, viewport),
    },
  };
}

function readLimrunViewport(
  tree: IosTreeNode | IosTreeNode[],
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
) {
  const treeEvidence = resolveIosViewportEvidenceFromRoots(
    (Array.isArray(tree) ? tree : [tree]).map(limrunViewportRoot),
  );
  if (treeEvidence?.kind === 'reported') {
    return { kind: 'derived' as const, rect: treeEvidence.rect };
  }
  return readLimrunDeviceInfoViewport(deviceInfo);
}

function limrunViewportRoot(node: IosTreeNode): IosSnapshotViewportRoot {
  const rawRect = node.rect ?? node.frame;
  const rect = completeRect(rawRect);
  return {
    type: node.elementType ?? node.type ?? node.role,
    ...(rect ? { rect } : {}),
    rectStatus: rectStatus(rawRect, rect),
  };
}

function completeRect(rect: IosTreeNode['rect']): IosSnapshotViewportRoot['rect'] | undefined {
  if (!isCompleteRect(rect)) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isCompleteRect(
  rect: IosTreeNode['rect'],
): rect is NonNullable<IosSnapshotViewportRoot['rect']> {
  return [rect?.x, rect?.y, rect?.width, rect?.height].every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rectStatus(
  rawRect: IosTreeNode['rect'],
  rect: IosSnapshotViewportRoot['rect'] | undefined,
): NonNullable<IosSnapshotViewportRoot['rectStatus']> {
  if (!rawRect) return 'not-provided';
  const complete =
    rawRect.x !== undefined &&
    rawRect.y !== undefined &&
    rawRect.width !== undefined &&
    rawRect.height !== undefined;
  if (!complete) return 'not-provided';
  return rect && rect.width > 0 && rect.height > 0 ? 'reported' : 'invalid';
}

function readLimrunDeviceInfoViewport(
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
) {
  const width = deviceInfo?.screenWidth;
  const height = deviceInfo?.screenHeight;
  if (width === undefined || height === undefined) {
    return { kind: 'missing' as const, reason: 'not-provided' as const };
  }
  if (!isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
    return { kind: 'missing' as const, reason: 'invalid' as const };
  }
  return { kind: 'reported' as const, rect: { x: 0, y: 0, width, height } };
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
