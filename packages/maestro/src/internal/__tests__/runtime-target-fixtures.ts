import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';

export type SnapshotNodeFixture = Omit<SnapshotNode, 'ref'> & { ref?: string };

export function makeSnapshot(nodes: SnapshotNodeFixture[]): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: nodes.map((node) => ({ ref: `e${node.index}`, ...node })),
  };
}

export const ANDROID_ROOTLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'android.widget.TextView',
    visibleToUser: true,
    rect: { x: 40, y: 300, width: 400, height: 80 },
  },
]);

export const ANDROID_SCROLL_CLIPPED_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'androidx.recyclerview.widget.RecyclerView',
    visibleToUser: true,
    rect: { x: 20, y: 100, width: 1040, height: 500 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'android.widget.TextView',
    visibleToUser: true,
    rect: { x: 40, y: 700, width: 400, height: 80 },
  },
]);

export const ANDROID_GEOMETRYLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'android.widget.FrameLayout',
    visibleToUser: true,
    rect: { x: 0, y: 0, width: 1080, height: 2400 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    hittable: true,
    visibleToUser: true,
    rect: { x: 40, y: 300, width: 400, height: 80 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'android.widget.TextView',
    visibleToUser: true,
  },
]);

export const IOS_GEOMETRYLESS_VISIBILITY_FIXTURE = makeSnapshot([
  {
    index: 0,
    type: 'Application',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    hittable: false,
    rect: { x: 20, y: 100, width: 200, height: 60 },
  },
  {
    index: 2,
    parentIndex: 1,
    type: 'StaticText',
  },
  {
    index: 3,
    parentIndex: 0,
    type: 'Button',
    hittable: true,
  },
]);
