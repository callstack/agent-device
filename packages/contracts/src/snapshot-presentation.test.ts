import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  createSnapshotPresentationNode,
  foldSnapshotRect,
  serializeRegularSnapshotPresentationNode,
} from './snapshot-presentation.ts';

const rawNode: RawSnapshotNode = {
  index: 7,
  type: 'Button',
  label: 'Save',
  rect: { x: 0, y: 0, width: 100, height: 80 },
  hittable: true,
};

test('the shared fold carries both viewport and ancestor clipping into effective geometry', () => {
  expect(
    foldSnapshotRect(
      rawNode.rect,
      { x: 20, y: 10, width: 50, height: 50 },
      { x: 30, y: 20, width: 100, height: 20 },
    ),
  ).toEqual({ x: 30, y: 20, width: 40, height: 20 });
});

test('regular serialization publishes effective geometry and fails closed on degenerate clips', () => {
  const presented = createSnapshotPresentationNode(rawNode, {
    x: 30,
    y: 20,
    width: 40,
    height: 20,
  });
  expect(serializeRegularSnapshotPresentationNode(presented)).toEqual({
    ...rawNode,
    rect: { x: 30, y: 20, width: 40, height: 20 },
    hittable: true,
  });

  expect(
    serializeRegularSnapshotPresentationNode(
      createSnapshotPresentationNode(rawNode, { x: 30, y: 20, width: 0, height: 20 }),
    ),
  ).toEqual({
    ...rawNode,
    rect: { x: 30, y: 20, width: 0, height: 20 },
    hittable: undefined,
  });
});
