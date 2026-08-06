import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotState } from '../snapshot-capture.ts';

export const profileNodes: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'Application',
    label: 'Profile',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'unfollow',
    label: 'Unfollow',
    rect: { x: 24, y: 200, width: 160, height: 44 },
    hittable: true,
  },
];

export const imageViewerNodes: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'Application',
    label: 'Image viewer',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'close-image',
    label: 'Close image',
    rect: { x: 24, y: 40, width: 120, height: 44 },
    hittable: true,
  },
];

export function snapshot(nodes: RawSnapshotNode[]) {
  return buildSnapshotState(
    {
      nodes,
      backend: 'xctest',
      quality: { state: 'healthy', backend: 'tree' },
    },
    { snapshotInteractiveOnly: false },
  );
}

export function snapshotPayload(
  nodes: RawSnapshotNode[],
  backend: 'tree' | 'queries' | 'private-ax' = 'tree',
) {
  return {
    backend: 'xctest' as const,
    nodes,
    quality: { state: 'healthy' as const, backend },
  };
}
