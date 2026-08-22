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

/**
 * One node per decision `resolveActionableTouchResolution` can reach, so an
 * indexed pass and an unindexed one can be compared across the whole policy
 * rather than on the branch a single example happens to hit: a same-rect
 * actionable descendant (1 -> 2), semantic targets (3, 4), a nonhittable leaf
 * under a hittable ancestor (5), both overly-broad shapes — a scrolling
 * container (7) and the viewport-sized root (10) — a covered node (8), and a
 * parentless, rectless node with no usable target at all (9).
 */
export const INDEXED_PARITY_POLICY_NODES: RawSnapshotNode[] = [
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
    type: 'XCUIElementTypeOther',
    label: 'Save wrapper',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: false,
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'XCUIElementTypeImage',
    identifier: 'save-hit-area',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: true,
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Save',
    rect: { x: 20, y: 200, width: 100, height: 40 },
    hittable: false,
  },
  {
    index: 4,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label: 'Account row',
    rect: { x: 10, y: 260, width: 370, height: 60 },
    hittable: true,
  },
  {
    index: 5,
    depth: 2,
    parentIndex: 4,
    type: 'XCUIElementTypeStaticText',
    label: 'Account',
    rect: { x: 24, y: 272, width: 80, height: 20 },
    hittable: false,
  },
  {
    index: 6,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeScrollView',
    rect: { x: 0, y: 340, width: 390, height: 300 },
    hittable: true,
  },
  {
    index: 7,
    depth: 2,
    parentIndex: 6,
    type: 'XCUIElementTypeOther',
    label: 'Feed item',
    rect: { x: 20, y: 360, width: 200, height: 40 },
    hittable: false,
  },
  {
    index: 8,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Under overlay',
    rect: { x: 20, y: 700, width: 100, height: 20 },
    hittable: false,
    interactionBlocked: 'covered',
  },
  {
    index: 9,
    depth: 0,
    type: 'XCUIElementTypeOther',
    label: 'Virtual item',
    hittable: false,
  },
  {
    index: 10,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Status',
    rect: { x: 20, y: 760, width: 60, height: 20 },
    hittable: false,
  },
];
