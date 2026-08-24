import { expect, test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotState } from '../snapshot-state.ts';

// End-to-end publication-membership contract for the acquire/present design (#1797, external
// review pass 4 finding 1), exercised through the production interface. Runner presentation owns
// eligibility (which nodes may appear at all); this pipeline owns publication membership (what
// agents actually see).
//
// Non-vacuity: with the collectIosStructuralIdentifierSuppression call disabled in noise.ts, the
// suppression test below fails because promo-banner is published. It passes only when the
// production suppression fires.
function publish(nodes: RawSnapshotNode[]) {
  return buildSnapshotState({ nodes, backend: 'xctest' }, { snapshotInteractiveOnly: true }).nodes;
}

const screen: RawSnapshotNode[] = [
  { index: 0, depth: 0, type: 'Application', label: 'ShopApp' },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'Image',
    label: 'Red sneakers product photo',
    rect: { x: 16, y: 130, width: 80, height: 44 },
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    value: '3 items',
    rect: { x: 300, y: 130, width: 86, height: 44 },
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'Other',
    identifier: 'promo-banner',
    rect: { x: 110, y: 130, width: 180, height: 44 },
  },
  // No label, identifier, or value: survival proves the interactive branch, not content.
  {
    index: 4,
    depth: 1,
    parentIndex: 0,
    type: 'Button',
    hittable: true,
    rect: { x: 16, y: 696, width: 370, height: 56 },
  },
];

test('publication keeps label content, value content, and bare interactive nodes', () => {
  const published = publish(screen);
  expect(published.some((node) => node.label === 'Red sneakers product photo')).toBe(true);
  expect(published.some((node) => node.value === '3 items')).toBe(true);
  expect(
    published.some(
      (node) => node.type === 'Button' && !node.label && !node.identifier && !node.value,
    ),
  ).toBe(true);
});

test('publication suppresses identifier-only structural Other wrappers, by declared policy', () => {
  const published = publish(screen);
  expect(published.some((node) => node.identifier === 'promo-banner')).toBe(false);
});

test('identifier-only nodes outside the structural-Other shape survive publication', () => {
  const published = publish([
    { index: 0, depth: 0, type: 'Application', label: 'ShopApp' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'submit-area',
      hittable: true,
      rect: { x: 16, y: 100, width: 370, height: 56 },
    },
  ]);
  expect(published.some((node) => node.identifier === 'submit-area')).toBe(true);
});
