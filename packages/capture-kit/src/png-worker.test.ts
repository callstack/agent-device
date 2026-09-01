import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resultTransferList } from './png-worker.ts';

test('resultTransferList transfers a buffer that fully owns its ArrayBuffer', () => {
  const owned = new Uint8Array(8).fill(1);

  const transfers = resultTransferList({ kind: 'encode', png: owned });

  assert.deepEqual(transfers, [owned.buffer]);
});

test('resultTransferList skips views that do not own their whole ArrayBuffer', () => {
  const backing = new Uint8Array(32);
  // Offset view: would detach unrelated data sharing the pool if transferred.
  const offsetView = backing.subarray(4, 12);
  // Zero-offset view that is shorter than its backing store (pooled-Buffer shape).
  const shortView = backing.subarray(0, 8);

  assert.deepEqual(resultTransferList({ kind: 'encode', png: offsetView }), []);
  assert.deepEqual(resultTransferList({ kind: 'encode', png: shortView }), []);
});

test('resultTransferList transfers only the fully-owned views of a mixed result', () => {
  const ownedDiffData = Buffer.alloc(16); // Buffer.alloc never uses the shared pool
  const pooledMask = new Uint8Array(new ArrayBuffer(32), 4, 8); // offset view, pooled-Buffer shape

  const transfers = resultTransferList({
    kind: 'diff-pixels',
    diffData: ownedDiffData,
    diffMask: pooledMask,
    differentPixels: 0,
  });

  assert.deepEqual(transfers, [ownedDiffData.buffer]);
});
