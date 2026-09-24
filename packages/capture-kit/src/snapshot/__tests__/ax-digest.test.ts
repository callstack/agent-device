import { expect, test } from 'vitest';
import { computeAxDigest } from '../snapshot-evidence.ts';

test('digest is stable across repeated calls for the same nodes', () => {
  const nodes = [
    { type: 'button', label: 'Continue', identifier: 'continue-btn' },
    { type: 'text', label: 'Welcome' },
  ];

  expect(computeAxDigest(nodes)).toEqual(computeAxDigest(nodes));
});

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

test('digest for an empty node array is stable and reports zero nodes', () => {
  const result = computeAxDigest([]);

  expect(result.nodeCount).toBe(0);
  expect(result.digest).toBe(computeAxDigest([]).digest);
});

test('digest separates the tuple fields so text shifted across them cannot collide', () => {
  // `hashNode` joins (type, label, identifier) through NUL separators. Drop them and
  // ('ab', '', '') hashes the same bytes as ('a', 'b', '') — two different trees that
  // would report identical evidence.
  const labelShifted = computeAxDigest([{ type: 'ab', label: '' }]);
  const labelSplit = computeAxDigest([{ type: 'a', label: 'b' }]);
  const identifierSplit = computeAxDigest([{ type: 'a', label: '', identifier: 'b' }]);

  expect(labelShifted.digest).not.toBe(labelSplit.digest);
  expect(labelShifted.digest).not.toBe(identifierSplit.digest);
});

test('digest is a versioned fixed-width hex string', () => {
  const { digest } = computeAxDigest([{ type: 'button', label: 'Continue' }]);

  expect(digest).toMatch(/^ax1:[0-9a-f]{16}$/);
});

test('golden: the ax1 wire format is pinned to these bytes', () => {
  // A digest is persisted as post-action evidence and compared across daemon restarts
  // (#1047), so the XOR width, separators, and count folding are all wire contract.
  const nodes = [
    { type: 'button', label: 'Continue', identifier: 'continue-btn' },
    { type: 'text', label: 'Welcome' },
    { type: 'image', label: 'Logo' },
  ];

  expect(computeAxDigest(nodes)).toEqual({
    digest: 'ax1:0a88b2cbf989ae22',
    nodeCount: 3,
  });
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
