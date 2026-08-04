// ADR 0012 decision 2: which candidate the heuristic picks among N>1 matches,
// and what it discloses about the choice. Viewport participation is the twin
// file, `resolve-viewport.test.ts`.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { parseSelectorChain } from './parse.ts';
import { resolveSelectorChain } from './resolve.ts';

test('resolveSelectorChain disambiguates to deeper/smaller matching node when enabled', () => {
  const disambiguationNodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      depth: 1,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Other',
      label: 'Press me',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('role="other" label="Press me" || label="Press me"');
  const resolved = resolveSelectorChain(disambiguationNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.matches, 2);
  // ADR 0012 decision 2: the comparator records which criterion decided —
  // here depth (e2 is deeper than e1).
  assert.equal(resolved.disambiguation?.tiebreak, 'deepest');
  assert.equal(resolved.disambiguation?.matchCount, 2);
  assert.deepEqual(
    resolved.disambiguation?.alternatives.map((node) => node.ref),
    ['e1'],
  );
});

test('resolveSelectorChain disambiguation records the smallest-area tiebreak when depths tie', () => {
  const sameDepthNodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Other',
      label: 'Press me',
      rect: { x: 10, y: 10, width: 20, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Press me"');
  const resolved = resolveSelectorChain(sameDepthNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.disambiguation?.tiebreak, 'smallest-area');
  assert.deepEqual(
    resolved.disambiguation?.alternatives.map((node) => node.ref),
    ['e1'],
  );
});

test('resolveSelectorChain discloses the winner versus its closest challenger, not the first comparison', () => {
  // e3 is the first losing candidate, so the previous side channel recorded
  // `visible`. e4 is the strongest loser, though: it is also visible, making
  // e2's extra depth the actual deciding criterion regardless of document order.
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 700, width: 200, height: 50 },
      depth: 3,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: -320, y: 240, width: 100, height: 20 },
      depth: 8,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 620, width: 200, height: 50 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];

  const resolved = resolveSelectorChain(nodes, parseSelectorChain('label="Profile"'), {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });

  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.disambiguation?.tiebreak, 'deepest');
});

test('resolveSelectorChain disambiguation tie falls back to next selector', () => {
  const tieNodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 40, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      type: 'Other',
      label: 'Press me',
      identifier: 'press_me_unique',
      rect: { x: 0, y: 80, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Press me" || id="press_me_unique"');
  const resolved = resolveSelectorChain(tieNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.selectorIndex, 1);
  assert.equal(resolved.node.ref, 'e3');
});
