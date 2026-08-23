import assert from 'node:assert/strict';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { PROPERTY_RUNS } from '../../../__tests__/test-utils/property-arbitraries.ts';
import {
  AndroidSnapshotPresentationFailure,
  createAndroidSnapshotPresentationNode,
  createAndroidSnapshotPresentationBudget,
  effectiveAndroidRect,
  isAndroidSnapshotPresentationFailure,
  serializeAndroidRegularPresentationNode,
  validateAndroidRegularPresentation,
} from '../snapshot-presentation.ts';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';

const rectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: -20, max: 500 }),
  height: fc.integer({ min: -20, max: 500 }),
});

const positiveRectArb = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  width: fc.integer({ min: 1, max: 500 }),
  height: fc.integer({ min: 1, max: 500 }),
});

test('regular Android snapshots publish cumulative effective geometry while raw keeps reported bounds', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" window-bounds="[0,0][400,800]" visible-to-user="true">
    <node class="android.widget.ScrollView" bounds="[0,100][300,500]" scrollable="true" visible-to-user="true">
      <node class="android.widget.ScrollView" bounds="[50,150][250,350]" scrollable="true" visible-to-user="true">
        <node class="android.widget.Button" text="Partially visible" bounds="[200,300][320,380]" clickable="true" visible-to-user="true" />
        <node class="android.widget.Button" text="Outside nested scroll" bounds="[260,360][380,420]" clickable="true" visible-to-user="true" />
      </node>
    </node>
  </node>
</hierarchy>`;

  const regular = parseUiHierarchy(xml, 800, {});
  const raw = parseUiHierarchy(xml, 800, { raw: true });

  expect(regular.nodes.find((node) => node.label === 'Partially visible')).toMatchObject({
    rect: { x: 200, y: 300, width: 50, height: 50 },
    hittable: true,
  });
  expect(regular.nodes.find((node) => node.label === 'Outside nested scroll')).toMatchObject({
    rect: { x: 260, y: 360, width: 0, height: 0 },
    hittable: undefined,
  });
  expect(raw.nodes.find((node) => node.label === 'Partially visible')).toMatchObject({
    rect: { x: 200, y: 300, width: 120, height: 80 },
    hittable: true,
  });
  expect(raw.nodes.find((node) => node.label === 'Outside nested scroll')).toMatchObject({
    rect: { x: 260, y: 360, width: 120, height: 60 },
    hittable: true,
  });
});

test('regular Android snapshots clip descendants to their owning window', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][400,800]" window-bounds="[0,0][400,800]" window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true" visible-to-user="true">
    <node class="android.widget.Button" text="Main action" bounds="[20,20][180,80]" clickable="true" visible-to-user="true" />
  </node>
  <node class="android.widget.FrameLayout" bounds="[100,100][300,300]" window-bounds="[100,100][300,300]" window-index="1" window-type="2" window-layer="2" window-active="true" window-focused="true" visible-to-user="true">
    <node class="android.widget.Button" text="Outside dialog" bounds="[120,320][180,380]" clickable="true" visible-to-user="true" />
  </node>
</hierarchy>`;

  const regular = parseUiHierarchy(xml, 800, {});
  const dialogAction = regular.nodes.find((node) => node.label === 'Outside dialog');

  expect(dialogAction).toMatchObject({
    rect: { x: 120, y: 320, width: 0, height: 0 },
    hittable: undefined,
  });
});

test('property: effective Android geometry stays inside every positive clip and never upgrades actionability', () => {
  fc.assert(
    fc.property(rectArb, positiveRectArb, positiveRectArb, (reported, viewport, ancestorClip) => {
      const effective = effectiveAndroidRect(reported, viewport, ancestorClip);
      const raw = { index: 0, depth: 0, rect: reported, hittable: true as const };
      const carrier = createAndroidSnapshotPresentationNode(raw, effective);
      const regular = serializeAndroidRegularPresentationNode(carrier);

      expect(carrier.raw.rect).toEqual(reported);
      expect(regular.rect).toEqual(effective);
      if (effective && effective.width > 0 && effective.height > 0) {
        expect(rectContains(viewport, effective)).toBe(true);
        expect(rectContains(ancestorClip, effective)).toBe(true);
        expect(regular.hittable).toBe(true);
      } else {
        expect(regular.hittable).toBeUndefined();
      }
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + Math.max(0, outer.width) &&
    inner.y + inner.height <= outer.y + Math.max(0, outer.height)
  );
}

test('regular Android invariant rejects a framed node outside its cumulative clip', () => {
  const budget = createAndroidSnapshotPresentationBudget(
    { deadlineAtMs: Number.POSITIVE_INFINITY },
    100,
  );
  const parent: RawSnapshotNode = {
    index: 0,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const escaped: RawSnapshotNode = {
    index: 1,
    parentIndex: 0,
    hittable: true,
  };

  assert.throws(
    () =>
      validateAndroidRegularPresentation(
        [
          createAndroidSnapshotPresentationNode(
            parent,
            { x: 0, y: 0, width: 100, height: 100 },
            true,
          ),
          createAndroidSnapshotPresentationNode(escaped, {
            x: 90,
            y: 90,
            width: 20,
            height: 20,
          }),
        ],
        { x: 0, y: 0, width: 100, height: 100 },
        budget,
      ),
    (error: unknown) => {
      assert.equal(isAndroidSnapshotPresentationFailure(error), true);
      assert(error instanceof AndroidSnapshotPresentationFailure);
      assert.equal(error.details.phase, 'regular-invariant');
      assert.equal(error.details.nodeIndex, 1);
      return true;
    },
  );
});

test('regular Android invariant validates disjoint roots against their owning windows', () => {
  const statusBar = { x: 0, y: 0, width: 1080, height: 136 };
  const dialog = { x: 28, y: 980, width: 1024, height: 513 };
  const budget = createAndroidSnapshotPresentationBudget(
    { deadlineAtMs: Number.POSITIVE_INFINITY },
    100,
  );

  assert.doesNotThrow(() =>
    validateAndroidRegularPresentation(
      [
        createAndroidSnapshotPresentationNode(
          { index: 0, rect: statusBar },
          statusBar,
          false,
          statusBar,
        ),
        createAndroidSnapshotPresentationNode({ index: 1, rect: dialog }, dialog, false, dialog),
      ],
      dialog,
      budget,
    ),
  );
});

test('hostile nested Android presentation stays under a deterministic linear work cap', () => {
  const depth = 240;
  const opening = Array.from(
    { length: depth },
    (_, index) =>
      `<node class="android.widget.FrameLayout" bounds="[0,0][320,640]"${
        index === depth - 1
          ? '><node class="android.widget.Button" text="Target" bounds="[0,0][80,40]" clickable="true" /></node>'
          : '>'
      }`,
  ).join('');
  const closing = '</node>'.repeat(depth - 1);
  const tree = parseUiHierarchyTree(`<hierarchy>${opening}${closing}</hierarchy>`);

  const built = buildUiHierarchySnapshot(tree, undefined, {
    androidPresentation: {
      deadlineAtMs: Number.POSITIVE_INFINITY,
      maxWorkUnits: depth * 32,
    },
  });

  assert.equal(built.truncated, undefined);
  assert.equal(
    built.nodes.some((node) => node.label === 'Target'),
    true,
  );
});

test('broad Android presentation rejects an oversized descendant footprint budget', () => {
  const siblingCount = 24;
  const buttons = (offset: number) =>
    Array.from({ length: siblingCount }, (_, index) => {
      const x = offset + index * 16;
      const y = 16 + index * 16;
      return `<node class="android.widget.Button" text="${offset}-${index}" bounds="[${x},${y}][${x + 8},${y + 8}]" clickable="true" visible-to-user="true" />`;
    }).join('');
  const tree = parseUiHierarchyTree(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][512,512]" visible-to-user="true">
      <node class="android.view.ViewGroup" drawing-order="1" bounds="[0,0][512,512]" visible-to-user="true">${buttons(0)}</node>
      <node class="android.view.ViewGroup" drawing-order="2" bounds="[0,0][512,512]" visible-to-user="true">${buttons(0)}</node>
    </node></hierarchy>`,
  );

  assert.throws(
    () =>
      buildUiHierarchySnapshot(tree, undefined, {
        androidPresentation: {
          deadlineAtMs: Number.POSITIVE_INFINITY,
          maxWorkUnits: 1024,
        },
      }),
    (error: unknown) => {
      assert.equal(isAndroidSnapshotPresentationFailure(error), true);
      assert(error instanceof AndroidSnapshotPresentationFailure);
      assert.equal(error.details.phase, 'complexity');
      assert(error.details.workUnits > 1024);
      return true;
    },
  );
});

test('hostile equal-order same-rect siblings charge the broad candidate scan', () => {
  const siblingCount = 72;
  const siblings = Array.from(
    { length: siblingCount },
    (_, index) =>
      `<node class="android.widget.Button" text="Sibling ${index}" bounds="[0,0][100,100]" clickable="true" drawing-order="1" visible-to-user="true" />`,
  ).join('');
  const tree = parseUiHierarchyTree(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][100,100]" visible-to-user="true">${siblings}</node></hierarchy>`,
  );

  assert.throws(
    () =>
      buildUiHierarchySnapshot(tree, undefined, {
        androidPresentation: {
          deadlineAtMs: Number.POSITIVE_INFINITY,
          maxWorkUnits: 2000,
        },
      }),
    (error: unknown) => {
      assert.equal(isAndroidSnapshotPresentationFailure(error), true);
      assert(error instanceof AndroidSnapshotPresentationFailure);
      assert.equal(error.details.phase, 'complexity');
      return true;
    },
  );
});

test('default budget admits a bounded flat hierarchy', () => {
  const siblings = Array.from(
    { length: 100 },
    (_, index) =>
      `<node class="android.widget.Button" text="Sibling ${index}" bounds="[0,0][100,100]" clickable="true" drawing-order="1" visible-to-user="true" />`,
  ).join('');
  const tree = parseUiHierarchyTree(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][100,100]" visible-to-user="true">${siblings}</node></hierarchy>`,
  );

  const built = buildUiHierarchySnapshot(tree, undefined, {
    androidPresentation: { deadlineAtMs: Number.POSITIVE_INFINITY },
  });

  assert.equal(built.nodes.length, 101);
});

test('one-axis footprint indexing remains inside the deterministic work budget', () => {
  const childCount = 80;
  const labels = Array.from(
    { length: childCount },
    (_, index) =>
      `<node class="android.widget.TextView" text="Label ${index}" bounds="[${index * 3},0][${index * 3 + 2},10]" visible-to-user="true" />`,
  ).join('');
  const tree = parseUiHierarchyTree(
    `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][240,20]" visible-to-user="true">
      <node class="android.widget.Button" text="Cover" bounds="[0,0][240,10]" clickable="true" drawing-order="2" visible-to-user="true" />
      <node class="android.view.ViewGroup" bounds="[0,0][240,10]" drawing-order="1" visible-to-user="true">${labels}</node>
    </node></hierarchy>`,
  );

  assert.throws(
    () =>
      buildUiHierarchySnapshot(tree, undefined, {
        androidPresentation: {
          deadlineAtMs: Number.POSITIVE_INFINITY,
          maxWorkUnits: 1650,
        },
      }),
    (error: unknown) => {
      assert.equal(isAndroidSnapshotPresentationFailure(error), true);
      assert(error instanceof AndroidSnapshotPresentationFailure);
      assert.equal(error.details.phase, 'complexity');
      return true;
    },
  );
});
