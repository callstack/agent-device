import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';

test('a disabled navigation title field is promoted to a Button without its hittability', () => {
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Demo',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'NavigationBar',
      label: 'Team Standup',
      rect: { x: 0, y: 56, width: 390, height: 44 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Image',
      identifier: 'RoomDetailsIconImageView',
      rect: { x: 81, y: 80, width: 14, height: 14 },
    },
    {
      index: 3,
      depth: 2,
      parentIndex: 1,
      type: 'TextField',
      label: 'Team Standup',
      value: 'Team Standup',
      identifier: 'DisplayNameTextField',
      enabled: false,
      hittable: false,
      rect: { x: 100, y: 67, width: 113, height: 22 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Team Standup',
      rect: { x: 219, y: 58, width: 85, height: 40 },
    },
  ];

  const presented = presentIosInteractiveSnapshot(nodes);
  const affordance = presented.find((node) => node.identifier === 'DisplayNameTextField');

  expect(affordance).toMatchObject({ type: 'Button', label: 'Team Standup', enabled: true });
  expect(affordance && 'hittable' in affordance).toBe(false);
});
