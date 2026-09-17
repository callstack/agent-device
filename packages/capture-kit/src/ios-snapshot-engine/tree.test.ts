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

test('a retracted fact stays retracted when a later rule patches the same node', () => {
  const heading: RawSnapshotNode = {
    index: 3,
    depth: 3,
    parentIndex: 2,
    type: 'Other',
    label: 'Welcome',
    value: '1',
    rect: { x: 0, y: 700, width: 390, height: 300 },
  };
  const replacements = new Map<number, RawSnapshotNode>();
  mergeReplacement(replacements, heading, { type: 'Heading', value: undefined });
  mergeReplacement(replacements, heading, { rect: { x: 0, y: 700, width: 390, height: 144 } });
  updateReplacement(replacements, heading, () => ({ label: 'Welcome!' }));

  const presented = replacements.get(heading.index);
  expect(presented).toMatchObject({ type: 'Heading', label: 'Welcome!' });
  expect(presented && 'value' in presented).toBe(false);
});
