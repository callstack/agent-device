import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { mergeReplacement, updateReplacement } from '@agent-device/capture-kit/ios-snapshot-engine';

test('replacement updates derive patches from the composed node', () => {
  const node: RawSnapshotNode = { index: 1, type: 'Table', hiddenContentBelow: true };
  const replacements = new Map<number, RawSnapshotNode>();

  mergeReplacement(replacements, node, { actions: ['Scroll down'] });
  updateReplacement(replacements, node, (current) => ({
    hiddenContentBelow: current.hiddenContentBelow,
    hiddenContentAbove: true,
  }));

  expect(replacements.get(node.index)).toMatchObject({
    actions: ['Scroll down'],
    hiddenContentAbove: true,
    hiddenContentBelow: true,
  });
});
