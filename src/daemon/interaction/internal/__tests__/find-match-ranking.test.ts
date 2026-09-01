import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RawSnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '../../../../__tests__/test-utils/snapshot-builders.ts';
import { preferOnscreenMatches } from '../find-match-ranking.ts';

const VIEWPORT = { x: 0, y: 0, width: 390, height: 844 };
const DUPLICATE_MATCH_COUNT = 32;

function observeWholeTreeScans(nodes: SnapshotState['nodes']): {
  observed: SnapshotState['nodes'];
  scans: { iterations: number; filter: number; map: number };
} {
  const scans = { iterations: 0, filter: 0, map: 0 };
  const observed = new Proxy(nodes, {
    get(target, property) {
      if (property === Symbol.iterator) scans.iterations += 1;
      if (property === 'filter' || property === 'map') scans[property] += 1;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { observed, scans };
}

/**
 * Duplicate-heavy and deliberately worst-case: every match is nonsemantic,
 * nonhittable and childless, so the old implementation had to run all three
 * whole-tree lookups — same-rect descendants, the nearest hittable ancestor's
 * index map, and the viewport roots an overly-broad ancestor is measured
 * against — once per candidate. Widths shrink as the list goes on so the
 * area tie-break has to reverse the input order.
 */
function duplicateHeavyCapture(): SnapshotState {
  const raw: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'XCUIElementTypeApplication',
      rect: VIEWPORT,
      hittable: true,
    },
  ];
  for (let position = 0; position < DUPLICATE_MATCH_COUNT; position += 1) {
    raw.push({
      index: position + 1,
      depth: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeOther',
      label: 'Item',
      rect: {
        x: 20,
        y: 40 + position * 20,
        width: 100 + (DUPLICATE_MATCH_COUNT - position),
        height: 16,
      },
      hittable: false,
    });
  }
  return makeSnapshotState(raw);
}

/**
 * One node per scoring branch the ranking rules distinguish: a semantic target,
 * a same-rect actionable descendant, a self-hittable node below the root, a
 * node whose only ancestor is the viewport-sized root, and a second semantic
 * target with the first one's exact area.
 */
const MIXED_SCORE_NODES: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'XCUIElementTypeApplication', rect: VIEWPORT, hittable: true },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Sync',
    rect: { x: 20, y: 100, width: 100, height: 40 },
    hittable: false,
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeOther',
    label: 'Sync',
    rect: { x: 20, y: 200, width: 120, height: 40 },
    hittable: false,
  },
  {
    index: 3,
    depth: 2,
    parentIndex: 2,
    type: 'XCUIElementTypeImage',
    identifier: 'sync-hit-area',
    rect: { x: 20, y: 200, width: 120, height: 40 },
    hittable: true,
  },
  {
    index: 4,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeOther',
    label: 'Sync',
    rect: { x: 20, y: 300, width: 80, height: 30 },
    hittable: true,
  },
  {
    index: 5,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeStaticText',
    label: 'Sync',
    rect: { x: 20, y: 400, width: 60, height: 20 },
    hittable: false,
  },
  {
    index: 6,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeButton',
    label: 'Sync',
    rect: { x: 200, y: 100, width: 100, height: 40 },
    hittable: false,
  },
];

test('a multi-match ranking pass scans the tree once', () => {
  const snapshot = duplicateHeavyCapture();
  const matches = snapshot.nodes.slice(1);
  const { observed, scans } = observeWholeTreeScans(snapshot.nodes);

  const ranked = preferOnscreenMatches(matches, observed);

  assert.deepEqual(scans, { iterations: 1, filter: 0, map: 0 });
  assert.deepEqual(
    ranked.map((node) => node.ref),
    [...matches].reverse().map((node) => node.ref),
  );
});

test('a single match returns without indexing the tree', () => {
  const snapshot = duplicateHeavyCapture();
  const { observed, scans } = observeWholeTreeScans(snapshot.nodes);

  const ranked = preferOnscreenMatches([snapshot.nodes[1]!], observed);

  assert.deepEqual(scans, { iterations: 0, filter: 0, map: 0 });
  assert.deepEqual(
    ranked.map((node) => node.ref),
    [snapshot.nodes[1]!.ref],
  );
});

test('a capture without a root rect returns matches unranked and unindexed', () => {
  const snapshot = makeSnapshotState([
    { index: 0, depth: 0, type: 'XCUIElementTypeApplication', hittable: true },
    ...MIXED_SCORE_NODES.slice(1),
  ]);
  const matches = snapshot.nodes.slice(1);
  const { observed, scans } = observeWholeTreeScans(snapshot.nodes);

  const ranked = preferOnscreenMatches(matches, observed);

  assert.deepEqual(scans, { iterations: 0, filter: 0, map: 0 });
  assert.deepEqual(
    ranked.map((node) => node.ref),
    matches.map((node) => node.ref),
  );
});

test('ranks by actionability score, then smallest rect, then input order', () => {
  const snapshot = makeSnapshotState(MIXED_SCORE_NODES);
  // Deliberately out of tree order so score, area, and input position each have
  // to decide a pair: [static text, second button, first button, wrapper, self-hittable].
  const matches = [5, 6, 1, 2, 4].map((index) => snapshot.nodes[index]!);

  const ranked = preferOnscreenMatches(matches, snapshot.nodes);

  assert.deepEqual(
    ranked.map((node) => node.ref),
    ['e7', 'e2', 'e3', 'e5', 'e6'],
  );
});
