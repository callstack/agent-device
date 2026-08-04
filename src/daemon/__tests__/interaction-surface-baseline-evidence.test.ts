import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
} from '../interaction-outcome-policy.ts';

// #1569: node shapes below are transcribed from a live iPhone 17 Pro capture of
// examples/test-app's checkout form, before and after `scroll down 0.6`. Two
// properties of that real screen are what these tests exist to hold:
//
//  - the scroll REPLACED the content: nothing from the form section survives
//    into the post capture, and the only identifiers common to both are the
//    tab-bar entries, which by construction never move;
//  - the captures disagree about which anonymous layout containers exist (the
//    live pair had 8 and 10 of them), so any rule that matches those by
//    ordinal position is reading noise.

const tabBar = (): SnapshotNode[] =>
  [
    { label: 'Home', type: 'Other', rect: { x: 21, y: 791, width: 360, height: 62 } },
    { label: 'Home', type: 'Button', rect: { x: 25, y: 795, width: 74, height: 54 } },
    {
      identifier: 'house.fill',
      label: 'home',
      type: 'Image',
      rect: { x: 45, y: 801, width: 33, height: 28 },
    },
  ] as SnapshotNode[];

const anonymousContainers = (count: number, baseY: number): SnapshotNode[] =>
  Array.from({ length: count }, (_, index) => ({
    type: 'Other',
    rect: { x: 0, y: baseY + index * 40, width: 402, height: 120 },
  })) as SnapshotNode[];

const formSection = (): SnapshotNode[] =>
  [
    { label: 'Full name', type: 'StaticText', rect: { x: 34, y: 319, width: 333, height: 17 } },
    {
      identifier: 'field-name',
      label: 'Full name',
      type: 'TextField',
      rect: { x: 35, y: 344, width: 333, height: 51 },
    },
    { label: 'Email', type: 'StaticText', rect: { x: 34, y: 410, width: 333, height: 17 } },
    {
      identifier: 'field-email',
      label: 'Email',
      type: 'TextField',
      rect: { x: 35, y: 435, width: 333, height: 51 },
    },
  ] as SnapshotNode[];

const deliverySection = (): SnapshotNode[] =>
  [
    {
      identifier: 'shipping-pickup',
      label: 'Pickup',
      type: 'Button',
      rect: { x: 126, y: 137, width: 75, height: 38 },
    },
    {
      identifier: 'checkbox-agree',
      label: 'I confirm the order details',
      type: 'Other',
      rect: { x: 34, y: 543, width: 333, height: 24 },
    },
  ] as SnapshotNode[];

const classify = (before: SnapshotNode[], after: SnapshotNode[]) =>
  classifyBaselineSurfaceEvidence(
    buildInteractionSurfaceSignature(before),
    buildInteractionSurfaceSignature(after),
  );

test('a scroll that replaces the content is changed, though every shared element sat still', () => {
  // The live shape of #1569. Shared identifiers: only the tab bar, all at dy=0.
  // Asking those whether the screen moved is asking the one part of the surface
  // guaranteed not to.
  assert.equal(
    classify(
      [...formSection(), ...anonymousContainers(8, 60), ...tabBar()],
      [...deliverySection(), ...anonymousContainers(10, 40), ...tabBar()],
    ),
    'changed',
  );
});

test('the verdict does not depend on which anonymous containers a capture happened to include', () => {
  // The defect: the previous rule matched anonymous nodes by ordinal position,
  // so its entire movement evidence came from containers that alias. Strip them
  // and it reported 'unchanged' for the very same pair of screens. Every
  // composition of the same two screens must agree.
  const compositions: [string, SnapshotNode[], SnapshotNode[]][] = [
    ['no containers', [...formSection(), ...tabBar()], [...deliverySection(), ...tabBar()]],
    [
      'matched container counts',
      [...formSection(), ...anonymousContainers(8, 60), ...tabBar()],
      [...deliverySection(), ...anonymousContainers(8, 60), ...tabBar()],
    ],
    [
      'mismatched container counts',
      [...formSection(), ...anonymousContainers(8, 60), ...tabBar()],
      [...deliverySection(), ...anonymousContainers(10, 40), ...tabBar()],
    ],
  ];

  for (const [label, before, after] of compositions) {
    assert.equal(classify(before, after), 'changed', label);
  }
});

test('an inert gesture stays unchanged while the anonymous container count fluctuates', () => {
  // The live pair carried 8 anonymous containers on one side and 10 on the
  // other for the SAME screen. Admitting them to the comparison makes that
  // fluctuation look like content both leaving and arriving — a false 'changed'
  // on a screen where nothing happened, which would settle a genuinely stale
  // capture on the strength of layout noise.
  assert.equal(
    classify(
      [...formSection(), ...anonymousContainers(8, 60), ...tabBar()],
      [...formSection(), ...anonymousContainers(10, 40), ...tabBar()],
    ),
    'unchanged',
  );
});

test('an inert gesture is unchanged even when volatile hittability flipped', () => {
  // `hittable` is viewport-derived, so it flips without the element moving.
  // Keying identity on it would drop this element from the comparison entirely.
  const before = [
    ...formSection().map((node) => ({ ...node, hittable: true })),
    ...tabBar(),
  ] as SnapshotNode[];
  const after = [
    ...formSection().map((node) => ({ ...node, hittable: false })),
    ...tabBar(),
  ] as SnapshotNode[];

  assert.equal(classify(before, after), 'unchanged');
});

test('a narrower capture of the same screen is scope drift, not movement', () => {
  // Baseline from a broad text search, quiet capture interactive-only: the
  // second is a strict subset. Nothing arrived, so nothing was replaced.
  assert.equal(classify([...formSection(), ...tabBar()], [...formSection()]), 'unchanged');
  assert.equal(classify([...formSection()], [...formSection(), ...tabBar()]), 'unchanged');
});

test('movement of a surviving element is still changed', () => {
  const moved = formSection().map((node) => ({
    ...node,
    rect: { ...node.rect!, y: node.rect!.y - 120 },
  })) as SnapshotNode[];

  assert.equal(classify([...formSection(), ...tabBar()], [...moved, ...tabBar()]), 'changed');
});

test('sharing only the tab bar is ambiguous once the content sets are disjoint on one side', () => {
  // Chrome alone carries no evidence: it reads identically whatever happened.
  assert.equal(classify(tabBar(), tabBar()), 'unchanged');
  assert.equal(classify([...formSection()], [...deliverySection()]), 'ambiguous');
});
