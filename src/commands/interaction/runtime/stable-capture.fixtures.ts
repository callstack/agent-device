import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';

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
