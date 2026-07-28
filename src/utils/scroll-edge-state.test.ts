import assert from 'node:assert/strict';
import { test } from 'vitest';

import { captureScrollEdgeState, runScrollEdgePasses } from './scroll-edge-state.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';

test('duplicate scroll-container labels do not scope edge verification to a child', async () => {
  const scopes: Array<string | undefined> = [];
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'StaticText',
      label: 'Automation lab',
      rect: { x: 18, y: -344, width: 311, height: 36 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async (scope) => {
      scopes.push(scope);
      return nodes;
    },
  });

  assert.equal(state.canScroll, true);
  assert.equal(state.scope, undefined);
  assert.deepEqual(scopes, [undefined]);
});

for (const collision of ['Automation lab details', 'AUTOMATION LAB']) {
  test(`native-style scope collision does not select ${JSON.stringify(collision)}`, async () => {
    const nodes: SnapshotNode[] = [
      {
        index: 1,
        ref: 'e1',
        type: 'ScrollView',
        label: 'Automation lab',
        hiddenContentAbove: true,
        rect: { x: 18, y: 178, width: 366, height: 662 },
      },
      {
        index: 2,
        ref: 'e2',
        parentIndex: 1,
        type: 'StaticText',
        label: collision,
        rect: { x: 18, y: -344, width: 311, height: 36 },
      },
    ];

    const state = await captureScrollEdgeState({
      edge: 'top',
      captureNodes: async () => nodes,
    });

    assert.equal(state.scope, undefined);
  });
}

test('value collision does not scope edge verification to an ambiguous subtree', async () => {
  const nodes: SnapshotNode[] = [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Automation lab',
      hiddenContentAbove: true,
      rect: { x: 18, y: 178, width: 366, height: 662 },
    },
    {
      index: 2,
      ref: 'e2',
      type: 'Other',
      value: 'Automation lab ready',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
  ];

  const state = await captureScrollEdgeState({
    edge: 'top',
    captureNodes: async () => nodes,
  });

  assert.equal(state.scope, undefined);
});

test('unique container scope is retained across edge pass captures', async () => {
  const scopes: Array<string | undefined> = [];
  const snapshots = [scrollSnapshot(true), scrollSnapshot(true), scrollSnapshot(false)];
  let captureIndex = 0;

  const result = await runScrollEdgePasses({
    edge: 'bottom',
    captureState: async (scope) =>
      await captureScrollEdgeState({
        edge: 'bottom',
        scope,
        captureNodes: async (capturedScope) => {
          scopes.push(capturedScope);
          return snapshots[Math.min(captureIndex++, snapshots.length - 1)] ?? [];
        },
      }),
    scroll: async () => ({ scrolled: true }),
  });

  assert.equal(result.passes, 1);
  assert.deepEqual(scopes, [undefined, 'Messages', 'Messages']);
});

function scrollSnapshot(hiddenContentBelow: boolean): SnapshotNode[] {
  return [
    {
      index: 1,
      ref: 'e1',
      type: 'ScrollView',
      label: 'Messages',
      hiddenContentBelow: hiddenContentBelow ? true : undefined,
      rect: { x: 0, y: 100, width: 400, height: 600 },
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'Button',
      label: hiddenContentBelow ? 'Middle message' : 'Latest message',
      rect: { x: 0, y: 640, width: 400, height: 56 },
    },
  ];
}
