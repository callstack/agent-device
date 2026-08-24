import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

const composerRect = { x: 0, y: 782, width: 402, height: 58 };
const actionShelfLabels = [
  'action media library',
  'action sticker',
  'action file',
  'action poll',
  'action location',
  'action camera',
] as const;

export const openComposerActionShelfNodes: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'Application',
    label: 'Fixture app',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'Other',
    label: 'Upload',
    identifier: 'RoomVCRoomInputToolbarContainer',
    rect: composerRect,
  },
  {
    index: 3,
    depth: 3,
    parentIndex: 2,
    type: 'Button',
    label: 'Upload',
    identifier: 'AttachButton',
    rect: {
      x: 4.544155877284288,
      y: 784.5441558772843,
      width: 50.91168824543142,
      height: 50.91168824543138,
    },
  },
  {
    index: 4,
    depth: 3,
    parentIndex: 2,
    type: 'ScrollView',
    label: 'action media library',
    rect: { x: 60, y: 790, width: 342, height: 38 },
  },
  ...actionShelfLabels.map((label, position) => ({
    index: position + 5,
    depth: 4,
    parentIndex: 4,
    type: 'Button',
    label,
    rect: { x: 60 + position * 58, y: 790, width: 38, height: 38 },
  })),
  {
    index: 11,
    depth: 3,
    parentIndex: 2,
    type: 'StaticText',
    label: 'Label',
    rect: { x: 82.67, y: 774.67, width: 229.33, height: 14.33 },
  },
  {
    index: 12,
    depth: 3,
    parentIndex: 2,
    type: 'Button',
    label: 'input close icon',
    rect: { x: 316, y: 767, width: 30, height: 30 },
  },
  {
    index: 13,
    depth: 3,
    parentIndex: 2,
    type: 'TextView',
    identifier: 'GrowingTextView',
    rect: { x: 65, y: 794, width: 276, height: 34 },
  },
  {
    index: 14,
    depth: 3,
    parentIndex: 2,
    type: 'Button',
    label: 'send icon',
    enabled: false,
    rect: { x: 354, y: 792, width: 36, height: 36 },
  },
  {
    index: 15,
    depth: 3,
    parentIndex: 2,
    type: 'Other',
    label: 'voice message lock icon unlock',
    rect: composerRect,
  },
  {
    index: 16,
    depth: 4,
    parentIndex: 15,
    type: 'Button',
    label: 'voice message lock icon unlock',
    rect: { x: 336, y: 775, width: 72, height: 72 },
  },
];

export const closedComposerWithRetainedActionShelfNodes: RawSnapshotNode[] =
  openComposerActionShelfNodes
    .filter((node) => node.parentIndex !== 4)
    .map((node) => {
      if (node.identifier === 'AttachButton') {
        return {
          ...node,
          rect: { x: 12, y: 792, width: 36, height: 36 },
        };
      }
      if (node.index === 4) {
        return {
          ...node,
          hiddenContentBelow: true,
          rect: { x: 60, y: 790, width: 342, height: 22 },
        };
      }
      if (node.index === 15 || node.index === 16) {
        return { ...node, label: 'Record Voice Message' };
      }
      return { ...node };
    });

export const closedComposerWithRetainedRegularTreeActionNodes: RawSnapshotNode[] =
  openComposerActionShelfNodes.map((node) => {
    if (node.identifier === 'AttachButton') {
      return {
        ...node,
        rect: { x: 12, y: 792, width: 36, height: 36 },
      };
    }
    if (node.index === 15 || node.index === 16) {
      return { ...node, label: 'Record Voice Message' };
    }
    return { ...node };
  });

export const navigationTitleWithAppProvidedDetailsAffordanceNodes: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'Application',
    label: 'Fixture app',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'NavigationBar',
    identifier: 'Team Standup',
    rect: { x: 0, y: 56.33, width: 402, height: 44 },
  },
  {
    index: 2,
    depth: 2,
    parentIndex: 1,
    type: 'StaticText',
    label: 'Team Standup',
    rect: { x: 219, y: 58.33, width: 85.67, height: 40 },
  },
  {
    index: 3,
    depth: 2,
    parentIndex: 1,
    type: 'Button',
    label: 'Video Call',
    rect: { x: 310.67, y: 56.33, width: 46, height: 44 },
  },
  {
    index: 4,
    depth: 2,
    parentIndex: 1,
    type: 'TextField',
    value: 'Team Standup',
    identifier: 'DisplayNameTextField',
    enabled: false,
    rect: { x: 100, y: 67.33, width: 113, height: 22 },
  },
  {
    index: 5,
    depth: 2,
    parentIndex: 1,
    type: 'Image',
    identifier: 'RoomDetailsIconImageView',
    rect: { x: 81, y: 80.33, width: 14, height: 14 },
  },
  {
    index: 6,
    depth: 2,
    parentIndex: 1,
    type: 'Button',
    label: 'Threads',
    rect: { x: 349.67, y: 67.33, width: 36.33, height: 22 },
  },
  {
    index: 7,
    depth: 1,
    parentIndex: 0,
    type: 'Table',
    label: 'Team Standup',
    rect: { x: 0, y: 100.33, width: 402, height: 600 },
  },
  {
    index: 8,
    depth: 2,
    parentIndex: 7,
    type: 'Cell',
    label: 'Team Standup',
    rect: { x: 0, y: 100.33, width: 402, height: 297.33 },
  },
  {
    index: 9,
    depth: 3,
    parentIndex: 8,
    type: 'Button',
    label: 'Team Standup',
    rect: { x: 20, y: 200.33, width: 362, height: 26.67 },
  },
];
