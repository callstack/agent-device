import {
  createIosSnapshotAcquisition,
  resolveIosViewportEvidenceFromRoots,
} from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { LimrunIosSession } from './ios.ts';
import { flattenIosTree, type IosTreeNode } from './snapshot.ts';

export async function captureLimrunIosSnapshot(
  session: Pick<LimrunIosSession, 'client' | 'instanceId'>,
): Promise<SnapshotRuntimeAcquiredResult> {
  const tree = JSON.parse(await session.client.elementTree()) as IosTreeNode | IosTreeNode[];
  const viewport = readLimrunViewport(tree, session.client.deviceInfo);
  return createIosSnapshotAcquisition({
    producer: 'limrun-ios-tree',
    nodes: flattenIosTree(tree),
    viewport,
    lineage: { targetId: session.instanceId },
  });
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

function limrunViewportRoot(node: IosTreeNode) {
  const rawRect = node.rect ?? node.frame;
  const rect = completeRect(rawRect);
  return {
    type: node.elementType ?? node.type ?? node.role,
    ...(rect ? { rect } : {}),
    rectStatus: viewportStatus(rawRect, rect),
  };
}

function completeRect(rect: IosTreeNode['rect']) {
  if (!isCompleteRect(rect)) return undefined;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function isCompleteRect(
  rect: IosTreeNode['rect'],
): rect is { x: number; y: number; width: number; height: number } {
  return [rect?.x, rect?.y, rect?.width, rect?.height].every(isFiniteNumber);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const viewportStatus = (
  rawRect: IosTreeNode['rect'],
  rect: ReturnType<typeof completeRect>,
): 'reported' | 'invalid' | 'not-provided' =>
  !rawRect || !rect ? 'not-provided' : rect.width > 0 && rect.height > 0 ? 'reported' : 'invalid';

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
