import { expect, test } from 'vitest';
import { elementClassicRoomListNodes, legitimatelyLabeledCellNodes } from './rows.fixtures.ts';
import { buildIosInteractiveSnapshotPresentation } from '../../../ios-snapshot-engine/index.ts';

test('iOS row presentation associates generic room cells with their descendant titles', () => {
  const nodes = buildIosInteractiveSnapshotPresentation(elementClassicRoomListNodes).nodes;

  expect(nodes.filter((node) => node.type === 'Cell').map((node) => node.label)).toEqual([
    'Book Club',
    'Team Standup',
  ]);
  expect(nodes.filter((node) => node.label === 'Book Club')).toHaveLength(1);
  expect(nodes.filter((node) => node.label === 'Team Standup')).toHaveLength(1);
});

test('iOS row presentation preserves a legitimate no-space cell label', () => {
  const nodes = buildIosInteractiveSnapshotPresentation(legitimatelyLabeledCellNodes).nodes;

  expect(nodes.find((node) => node.type === 'Cell')?.label).toBe('StemCell');
});
