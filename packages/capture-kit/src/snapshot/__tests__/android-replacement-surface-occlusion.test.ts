import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { coveredAndroidReplacementNodeIndexes } from '../android-replacement-surface-occlusion.ts';

test('dominant Android replacement surfaces cover stale sibling actions without removing them', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    node(1, 0, 'android.view.ViewGroup', [0, 0, 400, 800]),
    node(2, 1, 'android.widget.ScrollView', [0, 100, 400, 700]),
    {
      ...node(3, 2, 'android.widget.Button', [20, 140, 360, 60]),
      label: 'Foreground',
      hittable: true,
    },
    node(4, 0, 'android.view.ViewGroup', [0, 0, 400, 800]),
    { ...node(5, 4, 'android.widget.Button', [0, 260, 280, 60]), label: 'Stale', hittable: true },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders([
          [1, 2],
          [4, 1],
        ]),
      ),
    ],
    [4, 5],
  );
});

test('sparse floating Android overlays do not cover a richer app surface', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    node(1, 0, 'android.view.ViewGroup', [0, 0, 400, 800]),
    { ...node(2, 1, 'android.widget.TextView', [20, 80, 260, 60]), label: 'Editor' },
    { ...node(3, 1, 'android.widget.Button', [20, 700, 360, 60]), label: 'Save', hittable: true },
    node(4, 0, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    {
      ...node(5, 4, 'android.widget.ImageView', [330, 350, 50, 50]),
      label: 'Tools',
      hittable: true,
    },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders([
          [1, 1],
          [4, 2],
        ]),
      ),
    ],
    [],
  );
});

test('higher-order actionable descendants collectively cover a stale surface', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    { ...node(1, 0, 'android.widget.ScrollView', [0, 0, 400, 800]), hittable: true },
    { ...node(2, 1, 'android.widget.Button', [20, 700, 360, 60]), label: 'Stale', hittable: true },
    node(3, 0, 'android.view.ViewGroup', [0, 0, 400, 800]),
    { ...node(4, 3, 'android.widget.Button', [0, 0, 200, 800]), hittable: true },
    { ...node(5, 3, 'android.widget.Button', [200, 0, 200, 800]), hittable: true },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders([
          [1, 1],
          [3, 2],
        ]),
      ),
    ],
    [1, 2],
  );
});

test('side-by-side Android surfaces remain independently actionable', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    node(1, 0, 'android.view.ViewGroup', [0, 0, 120, 800]),
    { ...node(2, 1, 'android.widget.Button', [0, 200, 110, 60]), label: 'Drawer', hittable: true },
    node(3, 0, 'android.view.ViewGroup', [120, 0, 280, 800]),
    {
      ...node(4, 3, 'android.widget.Button', [150, 400, 220, 60]),
      label: 'Content',
      hittable: true,
    },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders([
          [1, 2],
          [3, 1],
        ]),
      ),
    ],
    [],
  );
});

test('presentation reparenting never compares order from different source sibling groups', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    { ...node(1, 0, 'android.widget.Button', [0, 0, 400, 800]), label: 'First', hittable: true },
    { ...node(2, 0, 'android.widget.Button', [0, 0, 400, 800]), label: 'Second', hittable: true },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        new Map([
          [1, { group: 0, order: 1 }],
          [2, { group: 1, order: 2 }],
        ]),
      ),
    ],
    [],
  );
});

test('mutually full Android surfaces stay actionable when normalized geometry cannot order them', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
    { ...node(1, 0, 'android.widget.ScrollView', [0, 0, 400, 800]), hittable: true },
    { ...node(2, 1, 'android.widget.Button', [20, 200, 360, 60]), label: 'First', hittable: true },
    { ...node(3, 0, 'android.widget.ScrollView', [0, 0, 400, 800]), hittable: true },
    { ...node(4, 3, 'android.widget.Button', [20, 500, 360, 60]), label: 'Second', hittable: true },
  ];

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders([
          [1, 1],
          [3, 1],
        ]),
      ),
    ],
    [],
  );
});

test('maximum-size flat Android captures stay within the linear classifier shape', () => {
  const nodes: RawSnapshotNode[] = [
    node(0, undefined, 'android.widget.FrameLayout', [0, 0, 400, 800]),
  ];
  for (let index = 1; index < 5000; index += 1) {
    nodes.push({
      ...node(index, 0, 'android.widget.Button', [0, 0, 400, 800]),
      label: `Action ${index}`,
      hittable: true,
    });
  }

  assert.deepEqual(
    [
      ...coveredAndroidReplacementNodeIndexes(
        nodes,
        siblingOrders(nodes.slice(1).map((candidate) => [candidate.index, 1])),
      ),
    ],
    [],
  );
});

function siblingOrders(entries: ReadonlyArray<readonly [number, number]>) {
  return new Map(entries.map(([index, order]) => [index, { group: 0, order }]));
}

function node(
  index: number,
  parentIndex: number | undefined,
  type: string,
  [x, y, width, height]: [number, number, number, number],
): RawSnapshotNode {
  return {
    index,
    parentIndex,
    depth: parentIndex === undefined ? 0 : 1,
    type,
    rect: { x, y, width, height },
  };
}
