import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { evaluateIsPredicate, normalizeIsPositionals } from './predicates.ts';

test('normalizeIsPositionals keeps canonical predicate-first arguments untouched', () => {
  assert.deepEqual(normalizeIsPositionals(['visible', 'text=Zzznope']), [
    'visible',
    'text=Zzznope',
  ]);
  assert.deepEqual(normalizeIsPositionals(['text', 'id=title', 'Welcome']), [
    'text',
    'id=title',
    'Welcome',
  ]);
  // Predicate-first wins even when the trailing token is also a predicate name: the
  // bare `hidden` here is the boolean selector term, not a competing predicate.
  assert.deepEqual(normalizeIsPositionals(['visible', 'hidden']), ['visible', 'hidden']);
});

test('normalizeIsPositionals rotates the selector-first form to predicate-first', () => {
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope', 'visible']), [
    'visible',
    'text=Zzznope',
  ]);
  assert.deepEqual(normalizeIsPositionals(['id=title', 'text', 'Welcome']), [
    'text',
    'id=title',
    'Welcome',
  ]);
  // Boolean selector terms before the trailing predicate stay inside the selector.
  assert.deepEqual(normalizeIsPositionals(['text=Foo', 'visible=true', 'selected']), [
    'selected',
    'text=Foo',
    'visible=true',
  ]);
  assert.deepEqual(normalizeIsPositionals(['label=Play', 'focused']), ['focused', 'label=Play']);
});

test('normalizeIsPositionals leaves unparseable arguments untouched', () => {
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope', 'nope']), ['text=Zzznope', 'nope']);
  assert.deepEqual(normalizeIsPositionals(['text=Zzznope']), ['text=Zzznope']);
  // The token before `visible` is not a valid selector, so no rotation applies.
  assert.deepEqual(normalizeIsPositionals(['Some Label', 'visible']), ['Some Label', 'visible']);
  assert.deepEqual(normalizeIsPositionals([]), []);
});

test('focused predicate reads snapshot focus state', () => {
  const node: SnapshotNode = {
    index: 0,
    ref: 'e0',
    type: 'android.widget.Button',
    label: 'Play',
    focused: true,
  };

  const result = evaluateIsPredicate({
    predicate: 'focused',
    node,
    visibility: createSnapshotVisibility([node]),
    platform: 'android',
  });

  assert.equal(result.pass, true);
  assert.match(result.details, /"focused":true/);
});

test('visible predicate treats zero-height hittable Android nodes as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.widget.Button',
      identifier: 'tab-4',
      label: 'Tab 4',
      rect: { x: 0, y: 800, width: 100, height: 0 },
      hittable: true,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[1]!,
    visibility: createSnapshotVisibility(nodes),
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate treats rectless hittable Android nodes as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      type: 'android.widget.Button',
      label: 'Library',
      hittable: true,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[1]!,
    visibility: createSnapshotVisibility(nodes),
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate uses visible Android ancestor geometry for rectless text', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Library',
      rect: { x: 20, y: 100, width: 160, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'android.widget.TextView',
      label: 'Library',
      hittable: false,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[2]!,
    visibility: createSnapshotVisibility(nodes),
    platform: 'android',
  });

  assert.equal(result.pass, true);
});

test('visible predicate treats Android nodes hidden from users as hidden', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.Button',
      label: 'Drawer item',
      rect: { x: 0, y: 0, width: 200, height: 80 },
      hittable: true,
      visibleToUser: false,
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[0]!,
    visibility: createSnapshotVisibility(nodes),
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

test('visible predicate does not use non-hittable Android layout ancestors for rectless text', () => {
  const nodes: SnapshotNode[] = [
    {
      index: 0,
      ref: 'e0',
      type: 'android.widget.FrameLayout',
      rect: { x: 0, y: 0, width: 1080, height: 2340 },
    },
    {
      index: 1,
      ref: 'e1',
      parentIndex: 0,
      type: 'android.view.ViewGroup',
      rect: { x: 0, y: 0, width: 816, height: 2340 },
      hittable: false,
    },
    {
      index: 2,
      ref: 'e2',
      parentIndex: 1,
      type: 'android.widget.Button',
      label: 'Albums',
      hittable: true,
    },
    {
      index: 3,
      ref: 'e3',
      parentIndex: 2,
      type: 'android.widget.TextView',
      label: 'Albums',
      value: 'Albums',
    },
  ];

  const result = evaluateIsPredicate({
    predicate: 'visible',
    node: nodes[3]!,
    visibility: createSnapshotVisibility(nodes),
    platform: 'android',
  });

  assert.equal(result.pass, false);
});

/** One capture whose two rows share a label: one on screen, one below the fold. */
const SHARED_CAPTURE: SnapshotNode[] = [
  { index: 0, ref: 'e0', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
  {
    index: 1,
    parentIndex: 0,
    ref: 'e1',
    type: 'TextField',
    label: 'Email',
    rect: { x: 0, y: 200, width: 400, height: 40 },
  },
  {
    index: 2,
    parentIndex: 0,
    ref: 'e2',
    type: 'TextField',
    label: 'Email',
    rect: { x: 0, y: 2400, width: 400, height: 40 },
  },
];

/**
 * `visible` answers from the index it is handed: two candidates of one capture read the one index the
 * caller built, and a predicate that built its own would leave these counters at zero. That an index
 * serves many nodes is `snapshot-visibility.test.ts`'s claim; this is the predicate's half of #1970.
 */
test('the visible predicate answers from the visibility index its caller built', () => {
  const materialized = { nodeMap: 0, viewportRects: 0 };
  const visibility = createSnapshotVisibility(SHARED_CAPTURE, {
    onNodeMapBuilt: () => (materialized.nodeMap += 1),
    onViewportRectsCollected: () => (materialized.viewportRects += 1),
  });

  const onScreen = evaluateIsPredicate({
    predicate: 'visible',
    node: SHARED_CAPTURE[1]!,
    visibility,
    platform: 'ios',
  });
  const scrolledOut = evaluateIsPredicate({
    predicate: 'visible',
    node: SHARED_CAPTURE[2]!,
    visibility,
    platform: 'ios',
  });

  assert.equal(onScreen.pass, true);
  assert.equal(scrolledOut.pass, false);
  assert.deepEqual(materialized, { nodeMap: 1, viewportRects: 1 });
});

/** The closest negative: `text` answers from the node alone and never consults the index. */
test('the text predicate never consults the visibility index', () => {
  const materialized = { nodeMap: 0, viewportRects: 0 };
  const visibility = createSnapshotVisibility(SHARED_CAPTURE, {
    onNodeMapBuilt: () => (materialized.nodeMap += 1),
    onViewportRectsCollected: () => (materialized.viewportRects += 1),
  });

  const match = evaluateIsPredicate({
    predicate: 'text',
    node: SHARED_CAPTURE[1]!,
    visibility,
    expectedText: 'Email',
    platform: 'ios',
  });

  assert.equal(match.pass, true);
  assert.deepEqual(materialized, { nodeMap: 0, viewportRects: 0 });
});
