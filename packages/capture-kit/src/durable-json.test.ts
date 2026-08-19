import assert from 'node:assert/strict';
import { test } from 'vitest';
import { freezeJsonObject, isBoundedJsonObject } from './durable-json.ts';

test('bounded durable JSON rejects cycles and excessive depth', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isBoundedJsonObject(cyclic), false);

  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  assert.equal(isBoundedJsonObject(nested), false);
});

test('bounded durable JSON accepts exactly the node cap and rejects one node past it', () => {
  // Every node counts: the root object, the `items` array, and each leaf. The
  // cap is 4,096 nodes, so 4,094 leaves sit exactly on it and 4,095 leaves are
  // the first document over. Depth stays at 2, so only the node budget can
  // decide either case, and the leaf kind selects which of the two counting
  // sites owns the rejection.
  const objectLeaves = (count: number) => ({ items: Array.from({ length: count }, () => ({})) });
  assert.equal(isBoundedJsonObject(objectLeaves(4_094)), true);
  assert.equal(isBoundedJsonObject(objectLeaves(4_095)), false);

  const arrayLeaves = (count: number) => ({
    items: Array.from({ length: count }, () => [] as never[]),
  });
  assert.equal(isBoundedJsonObject(arrayLeaves(4_094)), true);
  assert.equal(isBoundedJsonObject(arrayLeaves(4_095)), false);
});

test('validated durable JSON freezes without recursively revalidating every subtree', () => {
  let reads = 0;
  const leaf = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => {
      reads += 1;
      return 'leaf';
    },
  });
  const branch = Object.defineProperty({}, 'leaf', {
    enumerable: true,
    get: () => {
      reads += 1;
      return leaf;
    },
  });
  const body = Object.defineProperty({}, 'branch', {
    enumerable: true,
    get: () => {
      reads += 1;
      return branch;
    },
  });

  assert.equal(isBoundedJsonObject(body), true);
  freezeJsonObject(body);
  assert.ok(reads <= 6, `expected one validation and one freeze read per node, observed ${reads}`);
});
