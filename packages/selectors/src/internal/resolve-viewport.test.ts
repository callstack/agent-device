// The visibility half of ADR 0012 disambiguation: an on-screen candidate beats
// an off-screen one before depth/area is consulted, including when the node is
// on-screen itself but sits inside an off-screen scroll container. Ranking
// among equally-visible candidates is the twin file,
// `resolve-disambiguation.test.ts`.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { parseSelectorChain } from './parse.ts';
import { resolveSelectorChain } from './resolve.ts';

test('resolveSelectorChain disambiguation prefers on-screen candidates over off-screen ones', () => {
  // Bluesky-style closed drawer: the drawer's "Profile" sits fully off-screen
  // left (deeper + smaller, so pre-viewport ranking picked it) while the bottom
  // tab "Profile" is visible. The visible candidate must win.
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
      rect: { x: 20, y: 740, width: 200, height: 50 },
      depth: 2,
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
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Profile"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.matches, 2);
  // ADR 0012 decision 2: visibility decided this one, not depth/area — e3 is
  // both deeper and smaller than e2, so a depth/area-only comparator would
  // have picked the wrong node.
  assert.equal(resolved.disambiguation?.tiebreak, 'visible');
  assert.deepEqual(
    resolved.disambiguation?.alternatives.map((node) => node.ref),
    ['e3'],
  );
});

test('resolveSelectorChain disambiguation treats items inside an off-screen scroll container as off-screen', () => {
  // The closed drawer carries its own ScrollView at negative x. Visibility
  // relative to that (off-screen) container is not enough — the drawer item
  // must lose to the on-screen candidate.
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
      type: 'ScrollView',
      rect: { x: -320, y: 0, width: 320, height: 800 },
      depth: 1,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Profile',
      rect: { x: -310, y: 240, width: 100, height: 20 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 740, width: 200, height: 50 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Profile"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e4');
});

test('resolveSelectorChain disambiguation treats an edge-grazing off-screen container as off-screen', () => {
  // Bluesky regression: the closed drawer's overlay container pokes a fraction
  // of a pixel into the viewport (float rounding), but its center — the tap
  // point — is far off-screen. Edge overlap must not count as on-screen, so
  // with no other candidates the deeper drawer button still wins (and the
  // interaction guard then refuses it).
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Explore',
      rect: { x: -321.6, y: 0, width: 321.67, height: 874 },
      depth: 1,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Explore',
      rect: { x: -321.6, y: 240, width: 321.33, height: 50 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Explore"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  // Neither candidate counts as on-screen, so the deepest-smallest tiebreak
  // applies — NOT a preference for the edge-grazing container.
  assert.equal(resolved.node.ref, 'e3');
});

test('resolveSelectorChain disambiguation keeps deepest-smallest when all candidates are off-screen', () => {
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
      type: 'Other',
      label: 'Drawer item',
      rect: { x: -320, y: 200, width: 300, height: 300 },
      depth: 2,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Drawer item',
      rect: { x: -310, y: 240, width: 100, height: 20 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Drawer item"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e3');
});
