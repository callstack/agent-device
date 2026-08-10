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
