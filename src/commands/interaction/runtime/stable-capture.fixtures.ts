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
      {
        index: 10_000,
        depth: 2,
        parentIndex: 1,
        type: 'StaticText',
        label: 'Visible table heading',
        rect: { x: 0, y: 152, width: 180, height: 21 },
        hittable: false,
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
      snapshotQuality: {
        state: 'healthy',
        backend: 'tree',
      },
    },
  );
}

export function elementCollapsedScrollEdgeSnapshot(labels: [string, string]): SnapshotState {
  const state = elementSettingsSnapshot([997]);
  state.snapshotQuality = { state: 'recovered', backend: 'private-ax' };
  state.nodes.push(
    {
      index: 4,
      ref: 'e4',
      depth: 3,
      parentIndex: 3,
      type: 'StaticText',
      label: labels[0],
      rect: { x: 0, y: 152, width: 180, height: 21 },
      hittable: false,
    },
    {
      index: 5,
      ref: 'e5',
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: labels[1],
      rect: { x: 0, y: 152, width: 210, height: 21 },
      hittable: false,
    },
    {
      index: 6,
      ref: 'e6',
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Auto',
      rect: { x: 0, y: 152, width: 35, height: 21 },
      hittable: false,
    },
    {
      index: 7,
      ref: 'e7',
      depth: 3,
      parentIndex: 1,
      type: 'Switch',
      rect: { x: 0, y: 152, width: 51, height: 31 },
      hittable: true,
    },
    {
      index: 8,
      ref: 'e8',
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Message bubbles',
      rect: { x: 0, y: 152, width: 180, height: 21 },
      hittable: false,
    },
  );
  return state;
}
