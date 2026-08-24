import { expect, test } from 'vitest';
import { elementClassicRoomListNodes, legitimatelyLabeledCellNodes } from './rows.fixtures.ts';
import { presentIosInteractiveSnapshot } from './index.ts';

test('iOS row presentation associates generic room cells with their descendant titles', () => {
  const nodes = presentIosInteractiveSnapshot(elementClassicRoomListNodes);

  expect(nodes.filter((node) => node.type === 'Cell').map((node) => node.label)).toEqual([
    'Book Club',
    'Team Standup',
  ]);
  expect(nodes.filter((node) => node.label === 'Book Club')).toHaveLength(1);
  expect(nodes.filter((node) => node.label === 'Team Standup')).toHaveLength(1);
});

test('iOS row presentation preserves a legitimate no-space cell label', () => {
  const nodes = presentIosInteractiveSnapshot(legitimatelyLabeledCellNodes);

  expect(nodes.find((node) => node.type === 'Cell')?.label).toBe('StemCell');
});
