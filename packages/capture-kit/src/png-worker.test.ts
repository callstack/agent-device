import { test, vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { resultTransferList } from './png-worker.ts';
import { PNG } from './png.ts';
import type { PngWorkerResponse } from './png-worker-contract.ts';

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

test('resultTransferList transfers a cropped encoding and skips an untouched file', () => {
  const cropped = Buffer.alloc(32); // Buffer.alloc never uses the shared pool

  assert.deepEqual(resultTransferList({ kind: 'crop', png: cropped }), [cropped.buffer]);
  assert.deepEqual(resultTransferList({ kind: 'crop', png: null }), []);
});

test('resultTransferList transfers decoded pixels for both screenshot decode jobs', () => {
  const owned = Buffer.alloc(16); // Buffer.alloc never uses the shared pool
  const pooled = new Uint8Array(new ArrayBuffer(32), 4, 8); // offset view, pooled-Buffer shape
  const decoded = { width: 2, height: 2 };

  assert.deepEqual(resultTransferList({ kind: 'decode', ...decoded, data: owned }), [owned.buffer]);
  assert.deepEqual(resultTransferList({ kind: 'decode-image', ...decoded, data: owned }), [
    owned.buffer,
  ]);
  assert.deepEqual(resultTransferList({ kind: 'decode-image', ...decoded, data: pooled }), []);
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

test('worker encode replies preserve request identity and RGBA pixels across the message port', async () => {
  vi.resetModules();
  const { port1, port2 } = new MessageChannel();
  vi.doMock('node:worker_threads', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:worker_threads')>()),
    parentPort: port1,
  }));
  try {
    await import('./png-worker.ts');
    const pixels = Uint8Array.from([255, 0, 0, 0, 0, 255, 0, 127, 0, 0, 255, 255, 73, 81, 99, 25]);
    const reply = new Promise<PngWorkerResponse>((resolve) => port2.once('message', resolve));

    port2.postMessage({ id: 41, kind: 'encode', width: 2, height: 2, data: pixels });
    const response = await reply;

    assert.equal(response.id, 41);
    assert.ok(response.ok, JSON.stringify(response));
    assert.ok(response.result.kind === 'encode', 'Expected the encode result kind');
    const decoded = PNG.sync.read(Buffer.from(response.result.png));
    assert.deepEqual([decoded.width, decoded.height], [2, 2]);
    assert.deepEqual(decoded.data, Buffer.from(pixels));
  } finally {
    port1.close();
    port2.close();
    vi.doUnmock('node:worker_threads');
  }
});
