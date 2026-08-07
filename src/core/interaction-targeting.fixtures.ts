import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export const EQUIVALENT_WRAPPER_CHAIN_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeCell',
    label: 'Chat',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: false,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Chat',
    rect: { x: 10, y: 20, width: 300, height: 60 },
    hittable: true,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Chat',
    rect: { x: 24, y: 32, width: 80, height: 20 },
    hittable: false,
  },
];

export const ELEMENT14_DISTINCT_SUBTREE_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    rect: { x: 0, y: 0, width: 390, height: 844 },
    hittable: true,
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Team Standup',
    rect: { x: 20, y: 80, width: 200, height: 30 },
    hittable: false,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 0,
    type: 'XCUIElementTypeTextField',
    label: 'Team Standup',
    rect: { x: 20, y: 130, width: 350, height: 44 },
    hittable: false,
  },
  {
    index: 3,
    depth: 3,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label: 'Team Standup',
    rect: { x: 10, y: 180, width: 370, height: 80 },
    hittable: true,
  },
  {
    index: 4,
    depth: 8,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Team Standup',
    rect: { x: 151, y: 194, width: 100, height: 40 },
    hittable: true,
  },
];
