import {
  flattenAxeTree,
  readAxeTreeViewport,
  type AxeTreeNode,
} from '@agent-device/capture-kit/ios-axe-tree';
import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { LimrunIosSession } from './ios.ts';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { expandLimrunCollapsedTabBar } from './ios-collapsed-tab-bar.ts';

export async function captureLimrunIosSnapshot(
  session: Pick<LimrunIosSession, 'client' | 'instanceId'>,
): Promise<SnapshotRuntimeAcquiredResult> {
  const reported = (await session.client.elementTree()) as AxeTreeNode | AxeTreeNode[];
  const viewport = readLimrunViewport(reported, session.client.deviceInfo);
  const { tree, probeFailure } = await expandLimrunCollapsedTabBar(
    reported,
    viewport.kind === 'missing' ? null : viewport.rect,
    async (point) => (await session.client.elementTree(point)) as AxeTreeNode | AxeTreeNode[],
  );
  const nodes = flattenAxeTree(tree).map((node) => interpretIosNode(node));
  return createIosSnapshotAcquisition({
    producer: 'limrun-ios-tree',
    ...acquireProviderKeyboard({
      nodes,
      viewport: viewport.kind === 'missing' ? null : viewport.rect,
    }),
    viewport,
    lineage: { targetId: session.instanceId },
    ...(probeFailure ? { collapsedTabBarProbeFailure: probeFailure } : {}),
  });
}

function readLimrunViewport(
  tree: AxeTreeNode | AxeTreeNode[],
  deviceInfo: { screenWidth?: number; screenHeight?: number } | undefined,
) {
  const treeEvidence = readAxeTreeViewport(tree);
  if (treeEvidence?.kind === 'derived') return treeEvidence;
  return readLimrunDeviceInfoViewport(deviceInfo);
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
