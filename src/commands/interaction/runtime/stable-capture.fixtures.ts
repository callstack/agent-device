import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';

export function elementSettingsSnapshot(offscreenRowYs: number[]): SnapshotState {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'Element',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: false,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Table',
        rect: { x: 0, y: 152, width: 402, height: 660 },
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Cell',
        label: 'Visible profile row',
        rect: { x: 0, y: 251, width: 402, height: 69 },
        hittable: true,
      },
      ...offscreenRowYs.map((y, offset) => ({
        index: offset + 3,
        depth: 2,
        parentIndex: 1,
        type: 'Cell',
        label: '0',
        rect: { x: 0, y, width: 402, height: 49 },
        hittable: false,
      })),
    ],
    {
      backend: 'xctest',
      snapshotQuality: { state: 'healthy', backend: 'tree' },
    },
  );
}

export const elementThreadsNoticeSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Threads no longer experimental',
      rect: { x: 0, y: 400, width: 402, height: 474 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Got it',
      rect: { x: 16, y: 760, width: 370, height: 48 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);

export const elementTransientRoomSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextField',
      label: 'Weekend Plans',
      enabled: false,
      rect: { x: 100, y: 67, width: 113, height: 22 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'action file',
      rect: { x: 176, y: 790, width: 38, height: 38 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);

export const elementSettledRoomSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Weekend Plans',
      rect: { x: 81, y: 58, width: 224, height: 40 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Upload',
      rect: { x: 12, y: 792, width: 36, height: 36 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);
