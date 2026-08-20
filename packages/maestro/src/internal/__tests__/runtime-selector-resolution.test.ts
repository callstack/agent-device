import { expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { MaestroSelector } from '../program-ir.ts';
import { createMaestroSnapshotResolver } from '../runtime-selector-resolution.ts';
import type { MaestroPositionRelation } from '../runtime-target-position.ts';
import { makeSnapshot } from './runtime-target-fixtures.ts';

test('computes recursive selector sets once per snapshot instead of once per candidate', () => {
  const candidates: SnapshotNode[] = Array.from({ length: 128 }, (_, offset) => ({
    index: offset + 2,
    ref: `candidate-${offset}`,
    identifier: 'candidate',
    parentIndex: 0,
    rect: { x: 20, y: 200 + offset, width: 40, height: 30 },
  }));
  const snapshot = makeSnapshot([
    { index: 0, identifier: 'container', rect: { x: 0, y: 0, width: 320, height: 600 } },
    {
      index: 1,
      identifier: 'anchor',
      parentIndex: 0,
      rect: { x: 20, y: 100, width: 40, height: 30 },
    },
    ...candidates,
  ]);
  const childOf = { id: 'container' };
  const below = { id: 'anchor' };
  const selector: MaestroSelector = { id: 'candidate', childOf, below };
  const computedSelectors: MaestroSelector[] = [];
  const computedPositions: Array<[MaestroPositionRelation, MaestroSelector]> = [];
  let nodeMapBuilds = 0;
  const resolver = createMaestroSnapshotResolver(snapshot, {
    onNodeMapBuilt: () => nodeMapBuilds++,
    onSelectorComputed: (computed) => computedSelectors.push(computed),
    onPositionComputed: (relation, anchor) => computedPositions.push([relation, anchor]),
  });

  expect(resolver.resolve(selector).matches.map((node) => node.index)).toEqual(
    candidates.map((node) => node.index),
  );
  expect(nodeMapBuilds).toBe(1);
  expect(computedSelectors).toEqual([selector, childOf, below]);
  expect(computedPositions).toEqual([['below', below]]);

  resolver.resolve(selector);
  expect(computedSelectors).toHaveLength(3);
  expect(computedPositions).toHaveLength(1);
});

test('rejects cyclic selector graphs explicitly', () => {
  const selector: MaestroSelector = { id: 'candidate' };
  selector.childOf = selector;
  const resolver = createMaestroSnapshotResolver(makeSnapshot([]));

  expect(() => resolver.resolve(selector)).toThrow(/cannot contain cycles/);
});

test('resolves containment through array-offset parent links with non-contiguous indexes', () => {
  const snapshot = makeSnapshot([
    { index: 10, identifier: 'container' },
    { index: 20, identifier: 'middle', parentIndex: 0 },
    { index: 30, identifier: 'direct', parentIndex: 0 },
    { index: 40, identifier: 'nested', parentIndex: 1 },
  ]);
  const resolver = createMaestroSnapshotResolver(snapshot);

  expect(
    resolver
      .resolve({
        id: 'container',
        containsChild: { id: 'direct' },
        containsDescendants: [{ id: 'nested' }],
      })
      .indexed.map((node) => node.index),
  ).toEqual([10]);
  expect(
    resolver
      .resolve({ id: 'nested', childOf: { id: 'container' } })
      .indexed.map((node) => node.index),
  ).toEqual([40]);
});
