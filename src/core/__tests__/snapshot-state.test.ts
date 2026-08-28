import { expect, test } from 'vitest';
import { buildSnapshotState } from '../snapshot-state.ts';
import { isNodeVisibleOnScreen } from '@agent-device/contracts/snapshot';
import { attachSnapshotOcclusionContextEvidence } from '@agent-device/contracts/capture';
import {
  buildUiHierarchySnapshot,
  parseUiHierarchyTree,
} from '@agent-device/platform-android/mechanics';

test('buildSnapshotState handles undefined nodes gracefully', () => {
  const state = buildSnapshotState({ nodes: undefined, truncated: undefined }, undefined);
  expect(state.nodes).toEqual([]);
  expect(state.truncated).toBeUndefined();
  expect(state.createdAt).toBeGreaterThan(0);
});

test('buildSnapshotState handles completely empty data object', () => {
  const state = buildSnapshotState({}, undefined);
  expect(state.nodes).toEqual([]);
  expect(state.truncated).toBeUndefined();
});

test('buildSnapshotState carries structured snapshot quality verdicts', () => {
  const state = buildSnapshotState(
    {
      nodes: [{ index: 0, type: 'Application' }],
      backend: 'xctest',
      quality: {
        state: 'sparse',
        backend: 'private-ax',
        reason: 'sparse tree',
        reasonCode: 'sparse-tree',
      },
    },
    { snapshotInteractiveOnly: true },
  );

  expect(state.snapshotQuality).toMatchObject({
    state: 'sparse',
    backend: 'private-ax',
    reason: 'sparse tree',
    reasonCode: 'sparse-tree',
  });
});

// One channel, several producers: the state must keep who acquired the tree, not just where
// it came from (an `xctest`-channel tree here is an Appium page-source acquisition).
test('buildSnapshotState carries the acquisition producer beside the channel', () => {
  const state = buildSnapshotState(
    {
      nodes: [{ index: 0, type: 'Application' }],
      backend: 'xctest',
      producer: 'appium-source',
    },
    undefined,
  );

  expect(state.backend).toBe('xctest');
  expect(state.producer).toBe('appium-source');
});

test('buildSnapshotState preserves Android effective geometry for post-wire consumers', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" visible-to-user="true">
    <node class="android.widget.ScrollView" bounds="[0,100][300,500]" scrollable="true" visible-to-user="true">
      <node class="android.widget.Button" text="Partially visible" bounds="[200,300][320,380]" clickable="true" visible-to-user="true" />
    </node>
  </node>
</hierarchy>`;
  const built = buildUiHierarchySnapshot(parseUiHierarchyTree(xml), undefined, {});
  const state = buildSnapshotState({ nodes: built.nodes, backend: 'android' }, undefined);
  const target = state.nodes.find((node) => node.label === 'Partially visible');

  expect(target).toMatchObject({
    rect: { x: 200, y: 300, width: 100, height: 80 },
    hittable: true,
  });
  expect(target && isNodeVisibleOnScreen(target, state.nodes)).toBe(true);
});

test('buildSnapshotState handles nodes with missing fields', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        { index: 0 } as any,
        { index: 1, depth: undefined, type: undefined, label: undefined } as any,
      ],
      truncated: false,
      backend: 'android',
    },
    undefined,
  );
  expect(state.nodes).toHaveLength(2);
  expect(state.nodes[0]?.ref).toBeTruthy();
  expect(state.nodes[1]?.ref).toBeTruthy();
});

test('buildSnapshotState marks comparisonSafe false for filtered Android snapshots', () => {
  const nodes = [{ index: 0, depth: 0, type: 'android.widget.TextView', label: 'A' }];

  const interactiveOnly = buildSnapshotState(
    { nodes, backend: 'android' },
    { snapshotInteractiveOnly: true },
  );
  expect(interactiveOnly.comparisonSafe).toBe(false);

  const withDepth = buildSnapshotState({ nodes, backend: 'android' }, { snapshotDepth: 2 });
  expect(withDepth.comparisonSafe).toBe(false);

  const withScope = buildSnapshotState({ nodes, backend: 'android' }, { snapshotScope: 'Header' });
  expect(withScope.comparisonSafe).toBe(false);

  const unfiltered = buildSnapshotState({ nodes, backend: 'android' }, {});
  expect(unfiltered.comparisonSafe).toBe(true);
});

test('buildSnapshotState applies iOS interactive presentation for xctest snapshots', () => {
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };
  const state = buildSnapshotState(
    {
      nodes: [
        { index: 0, depth: 0, type: 'Application', label: 'Settings' },
        { index: 1, depth: 1, parentIndex: 0, type: 'CollectionView' },
        { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'General', rect: rowRect },
        { index: 3, depth: 3, parentIndex: 2, type: 'Button', label: 'General', rect: rowRect },
      ],
      backend: 'xctest',
    },
    { snapshotInteractiveOnly: true },
  );

  expect(state.nodes.map((node) => [node.type, node.label, node.parentIndex])).toEqual([
    ['Application', 'Settings', undefined],
    ['CollectionView', undefined, 0],
    ['Cell', 'General', 1],
  ]);
});

test('buildSnapshotState marks content covered by floating overlays as visible but blocked', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          label: 'Example',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Save draft',
          rect: { x: 16, y: 790, width: 140, height: 44 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'TabBar',
          rect: { x: 0, y: 760, width: 390, height: 84 },
          hittable: true,
        },
      ],
      backend: 'xctest',
    },
    undefined,
  );

  const covered = state.nodes.find((node) => node.label === 'Save draft');
  expect(covered).toMatchObject({
    label: 'Save draft',
    hittable: false,
    interactionBlocked: 'covered',
    presentationHints: ['covered'],
  });
  expect(state.nodes.some((node) => node.type === 'TabBar')).toBe(true);
});

test('buildSnapshotState marks Android app content covered by IME overlays as blocked', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'android.widget.FrameLayout',
          bundleId: 'org.example',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.Button',
          label: 'Push Article',
          bundleId: 'org.example',
          rect: { x: 40, y: 600, width: 180, height: 56 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          type: 'android.widget.FrameLayout',
          bundleId: 'com.google.android.inputmethod.latin',
          rect: { x: 0, y: 400, width: 390, height: 444 },
        },
      ],
      backend: 'android',
    },
    undefined,
  );

  expect(state.nodes.find((node) => node.label === 'Push Article')).toMatchObject({
    hittable: false,
    interactionBlocked: 'covered',
    presentationHints: ['covered'],
  });
});

test('buildSnapshotState keeps a sparse Android overlay actionable above scrollable app content', () => {
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.ScrollView',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Save',
      rect: { x: 20, y: 700, width: 360, height: 60 },
      hittable: true,
    },
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 3,
      type: 'android.widget.ImageView',
      label: 'Tools',
      rect: { x: 330, y: 350, width: 50, height: 50 },
      hittable: true,
    },
  ];
  const state = buildSnapshotState(
    attachSnapshotOcclusionContextEvidence(
      { nodes, backend: 'android' as const },
      {
        nodes,
        sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
        androidSiblingOrderByNodeIndex: new Map([
          [1, { group: 0, order: 1 }],
          [3, { group: 0, order: 2 }],
        ]),
      },
    ),
    undefined,
  );

  expect(state.nodes.find((node) => node.label === 'Save')).toMatchObject({ hittable: true });
  expect(state.nodes.find((node) => node.label === 'Tools')).toMatchObject({ hittable: true });
  expect(state.nodes.find((node) => node.label === 'Tools')?.interactionBlocked).toBeUndefined();
});

test('buildSnapshotState handles a maximum-size deeply nested Android replacement candidate', () => {
  const nestedSurface = Array.from({ length: 4998 }, (_, offset) => {
    const index = offset + 1;
    const isLeaf = index === 4998;
    return {
      index,
      depth: index,
      parentIndex: index === 1 ? 0 : index - 1,
      type: isLeaf ? 'android.widget.Button' : 'android.view.ViewGroup',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      ...(isLeaf ? { label: 'Deep action', hittable: true } : {}),
    };
  });
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    ...nestedSurface,
    {
      index: 4999,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Sibling action',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
  ];
  const state = buildSnapshotState(
    attachSnapshotOcclusionContextEvidence(
      { nodes, backend: 'android' as const },
      {
        nodes,
        sourceIndexByNodeIndex: new Map(nodes.map((node) => [node.index, node.index])),
        androidSiblingOrderByNodeIndex: new Map([
          [1, { group: 0, order: 2 }],
          [4999, { group: 0, order: 1 }],
        ]),
      },
    ),
    undefined,
  );

  expect(state.nodes.some((node) => node.label === 'Deep action')).toBe(true);
  expect(state.nodes.some((node) => node.label === 'Sibling action')).toBe(true);
});

test('buildSnapshotState treats large Android IME subtrees as one overlay root', () => {
  const imeChildren = Array.from({ length: 2000 }, (_, offset) => ({
    index: offset + 3,
    depth: 2,
    parentIndex: 2,
    type: 'android.widget.TextView',
    label: `Keyboard suggestion ${offset}`,
    bundleId: 'com.google.android.inputmethod.latin',
    rect: { x: offset % 300, y: 500 + (offset % 200), width: 80, height: 32 },
  }));

  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'android.widget.FrameLayout',
          bundleId: 'org.example',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'android.widget.Button',
          label: 'Covered action',
          bundleId: 'org.example',
          rect: { x: 40, y: 620, width: 180, height: 56 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          type: 'android.widget.FrameLayout',
          bundleId: 'com.google.android.inputmethod.latin',
          rect: { x: 0, y: 400, width: 390, height: 444 },
        },
        ...imeChildren,
      ],
      backend: 'android',
    },
    undefined,
  );

  expect(state.nodes.find((node) => node.label === 'Covered action')).toMatchObject({
    hittable: false,
    interactionBlocked: 'covered',
  });
});

test('buildSnapshotState does not treat later generic hittable containers as covers', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Visible action',
          rect: { x: 40, y: 100, width: 160, height: 44 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'CollectionView',
          label: 'Content list',
          rect: { x: 0, y: 80, width: 390, height: 600 },
          hittable: true,
        },
      ],
      backend: 'xctest',
    },
    undefined,
  );

  expect(state.nodes.find((node) => node.label === 'Visible action')).toMatchObject({
    hittable: true,
  });
  expect(
    state.nodes.find((node) => node.label === 'Visible action')?.interactionBlocked,
  ).toBeUndefined();
});

test('buildSnapshotState does not let covered overlays cover earlier targets', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Top action',
          rect: { x: 20, y: 30, width: 120, height: 44 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Middle action',
          rect: { x: 20, y: 170, width: 120, height: 44 },
          hittable: true,
        },
        {
          index: 3,
          depth: 1,
          parentIndex: 0,
          type: 'ToolBar',
          rect: { x: 0, y: 0, width: 390, height: 300 },
          hittable: true,
        },
        {
          index: 4,
          depth: 1,
          parentIndex: 0,
          type: 'Sheet',
          rect: { x: 0, y: 120, width: 390, height: 724 },
          hittable: true,
        },
      ],
      backend: 'xctest',
    },
    undefined,
  );

  expect(state.nodes.find((node) => node.label === 'Middle action')).toMatchObject({
    interactionBlocked: 'covered',
  });
  expect(state.nodes.find((node) => node.type === 'ToolBar')).toMatchObject({
    interactionBlocked: 'covered',
  });
  expect(state.nodes.find((node) => node.label === 'Top action')).toMatchObject({
    hittable: true,
  });
  expect(
    state.nodes.find((node) => node.label === 'Top action')?.interactionBlocked,
  ).toBeUndefined();
});

test('buildSnapshotState leaves raw snapshot hittability untouched', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'Application',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          depth: 1,
          parentIndex: 0,
          type: 'Button',
          label: 'Save draft',
          rect: { x: 16, y: 790, width: 140, height: 44 },
          hittable: true,
        },
        {
          index: 2,
          depth: 1,
          parentIndex: 0,
          type: 'TabBar',
          rect: { x: 0, y: 760, width: 390, height: 84 },
          hittable: true,
        },
      ],
      backend: 'xctest',
    },
    { snapshotRaw: true },
  );

  expect(state.nodes.find((node) => node.label === 'Save draft')).toMatchObject({
    hittable: true,
  });
  expect(
    state.nodes.find((node) => node.label === 'Save draft')?.interactionBlocked,
  ).toBeUndefined();
});

test('buildSnapshotState returns empty nodes when a post-wire scoped snapshot has no match', () => {
  const nodes = [
    { index: 0, depth: 0, type: 'Window', label: 'Root' },
    { index: 1, depth: 1, type: 'Button', label: 'Search' },
  ];

  const state = buildSnapshotState({ nodes }, { snapshotScope: 'zzzz-no-match-token' });

  expect(state.nodes).toEqual([]);
});

test('buildSnapshotState preserves macOS helper scope behavior', () => {
  const state = buildSnapshotState(
    {
      nodes: [
        { index: 0, depth: 0, type: 'Window', label: 'Desktop surface' },
        { index: 1, depth: 1, parentIndex: 0, type: 'Button', label: 'Target' },
      ],
      backend: 'macos-helper',
    },
    { snapshotScope: 'missing scope' },
  );

  expect(state.nodes.map((node) => node.label)).toEqual(['Desktop surface', 'Target']);
  expect(state.nodes.every((node) => node.ref)).toBe(true);
});
