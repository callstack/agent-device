import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

const roomRowRect = { x: 0, y: 400, width: 402, height: 96 };

export const elementClassicRoomListNodes: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', label: 'Element Classic' },
  { index: 1, depth: 1, parentIndex: 0, type: 'Table', label: 'HomeVCTableView' },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'Cell',
    identifier: 'RecentTableViewCell',
    label: 'Vertical scroll bar, 1 page',
    rect: roomRowRect,
  },
  { index: 3, depth: 3, parentIndex: 2, type: 'StaticText', label: 'Book Club' },
  {
    index: 4,
    depth: 3,
    parentIndex: 2,
    type: 'StaticText',
    label: 'Dave: Loving it so far, the worldbuilding is great.',
  },
  { index: 5, depth: 3, parentIndex: 2, type: 'StaticText', label: '03:55' },
  {
    index: 6,
    depth: 2,
    parentIndex: 1,
    type: 'Cell',
    identifier: 'RecentTableViewCell',
    label: 'Vertical scroll bar, 1 page',
    rect: { ...roomRowRect, y: 496 },
  },
  { index: 7, depth: 3, parentIndex: 6, type: 'StaticText', label: 'Team Standup' },
  { index: 8, depth: 3, parentIndex: 6, type: 'StaticText', label: 'Dave: No blockers from me.' },
  { index: 9, depth: 3, parentIndex: 6, type: 'StaticText', label: '03:55' },
];

export const legitimatelyLabeledCellNodes: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', label: 'Example' },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Cell',
    label: 'StemCell',
    rect: roomRowRect,
  },
  { index: 2, depth: 2, parentIndex: 1, type: 'StaticText', label: 'Research details' },
];
