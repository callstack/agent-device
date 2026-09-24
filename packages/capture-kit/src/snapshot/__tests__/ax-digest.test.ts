import { expect, test } from 'vitest';
import { computeAxDigest } from '../snapshot-evidence.ts';

test('digest is order-independent over the node multiset', () => {
  const a = [
    { type: 'button', label: 'Continue', identifier: 'continue-btn' },
    { type: 'text', label: 'Welcome' },
    { type: 'image', label: 'Logo' },
  ];
  const b = [a[2]!, a[0]!, a[1]!];

  expect(computeAxDigest(a).digest).toBe(computeAxDigest(b).digest);
});

test('digest changes when a node label changes', () => {
  const before = computeAxDigest([{ type: 'button', label: 'Continue' }]);
  const after = computeAxDigest([{ type: 'button', label: 'Continue!' }]);

  expect(after.digest).not.toBe(before.digest);
});

test('digest changes when a node type changes', () => {
  const before = computeAxDigest([{ type: 'button', label: 'Continue' }]);
  const after = computeAxDigest([{ type: 'link', label: 'Continue' }]);

  expect(after.digest).not.toBe(before.digest);
});

test('digest changes when a node identifier changes', () => {
  const before = computeAxDigest([{ type: 'button', label: 'Continue', identifier: 'a' }]);
  const after = computeAxDigest([{ type: 'button', label: 'Continue', identifier: 'b' }]);

  expect(after.digest).not.toBe(before.digest);
});

test('digest changes when node count changes even with the same multiset otherwise', () => {
  const one = computeAxDigest([{ type: 'button', label: 'Continue' }]);
  const two = computeAxDigest([
    { type: 'button', label: 'Continue' },
    { type: 'button', label: 'Continue' },
  ]);

  expect(two.digest).not.toBe(one.digest);
  expect(two.nodeCount).toBe(2);
  expect(one.nodeCount).toBe(1);
});

test('digest reports zero nodes for an empty node array', () => {
  expect(computeAxDigest([]).nodeCount).toBe(0);
});

test('digest is prefixed for forward-compatible versioning', () => {
  const result = computeAxDigest([{ type: 'button', label: 'Continue' }]);

  expect(result.digest.startsWith('ax1:')).toBe(true);
});

test('digest ignores volatile fields such as rects that are not part of the tuple', () => {
  const withRect = computeAxDigest([
    {
      type: 'button',
      label: 'Continue',
      identifier: 'a',
      ...({ rect: { x: 1, y: 2, width: 3, height: 4 } } as Record<string, unknown>),
    },
  ]);
  const withoutRect = computeAxDigest([{ type: 'button', label: 'Continue', identifier: 'a' }]);

  expect(withRect.digest).toBe(withoutRect.digest);
});
