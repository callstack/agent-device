import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { PNG } from './png.ts';

test('an unavailable worker still encodes every RGBA channel', async () => {
  vi.resetModules();
  vi.doMock('./internal-entry.ts', () => ({ resolveInternalEntryModulePath: () => null }));
  const { encodePngAsync } = await import('./png-worker-client.ts');
  const png = new PNG({ width: 2, height: 1 });
  png.data = Buffer.from([23, 45, 67, 0, 89, 123, 231, 127]);
  const decoded = PNG.sync.read(await encodePngAsync(png));
  expect([decoded.width, decoded.height]).toEqual([2, 1]);
  expect(decoded.data).toEqual(png.data);
  vi.doUnmock('./internal-entry.ts');
});

test('a worker whose entry is missing is reported once and later registrations hear it', async () => {
  vi.resetModules();
  vi.doMock('./internal-entry.ts', () => ({ resolveInternalEntryModulePath: () => null }));
  const { decodePngAsync, retainPngWorker } = await import('./png-worker-client.ts');
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const first = vi.fn();
  const second = vi.fn();

  const releaseFirst = retainPngWorker(first);
  const decoded = await decodePngAsync(png, 'fallback');
  const releaseSecond = retainPngWorker(second);

  expect(decoded.width).toBe(1);
  expect(first.mock.calls).toEqual([[{ kind: 'entry-not-found' }]]);
  expect(second.mock.calls).toEqual([[{ kind: 'entry-not-found' }]]);
  await releaseFirst();
  await releaseSecond();
  vi.doUnmock('./internal-entry.ts');
});

test('a worker that dies after it started is reported once, and its pending job still completes', async () => {
  vi.resetModules();
  class FakeWorker extends EventEmitter {
    static last: FakeWorker | undefined;
    constructor() {
      super();
      FakeWorker.last = this;
    }
    postMessage(): void {}
    ref(): void {}
    unref(): void {}
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }
  vi.doMock('node:worker_threads', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:worker_threads')>()),
    Worker: FakeWorker,
  }));
  const { decodePngAsync, retainPngWorker } = await import('./png-worker-client.ts');
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const unavailable = vi.fn();
  const release = retainPngWorker(unavailable);
  expect(unavailable).not.toHaveBeenCalled();

  const decoded = decodePngAsync(png, 'under-request');
  const worker = FakeWorker.last;
  if (!worker) throw new Error('the pre-warm did not start a worker');
  worker.emit('error', new Error('worker crashed'));
  worker.emit('exit', 1);

  expect((await decoded).width).toBe(1);
  expect(unavailable.mock.calls).toEqual([[{ kind: 'worker-error', detail: 'worker crashed' }]]);
  await release();
  vi.doUnmock('node:worker_threads');
});
