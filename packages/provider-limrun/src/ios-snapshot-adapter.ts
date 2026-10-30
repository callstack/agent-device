import { interpretIosNode } from '@agent-device/capture-kit/ios-node-interpretation';
import { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type { LimrunIosSession } from './ios.ts';
import { acquireProviderKeyboard } from '@agent-device/contracts/tap-keyboard-occlusion';
import { expandLimrunCollapsedTabBar } from './ios-collapsed-tab-bar.ts';
import {
  flattenIosTree,
  resolveIosAxTreeViewport,
  type IosTreeNode,
} from '@agent-device/capture-kit/ios-ax-tree';

export async function captureLimrunIosSnapshot(
  session: Pick<LimrunIosSession, 'client' | 'instanceId'>,
): Promise<SnapshotRuntimeAcquiredResult> {
  const reported = (await session.client.elementTree()) as IosTreeNode | IosTreeNode[];
  const deviceInfo = session.client.deviceInfo;
  const viewport = resolveIosAxTreeViewport(
    reported,
    deviceInfo && { width: deviceInfo.screenWidth, height: deviceInfo.screenHeight },
  );
  const { tree, probeFailure } = await expandLimrunCollapsedTabBar(
    reported,
    viewport.kind === 'missing' ? null : viewport.rect,
    async (point) => (await session.client.elementTree(point)) as IosTreeNode | IosTreeNode[],
  );
  const nodes = flattenIosTree(tree).map((node) => interpretIosNode(node));
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
