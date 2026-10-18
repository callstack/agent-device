import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { PNG } from './png.ts';

test('every scope that reaches the fallback reports the unavailable worker', async () => {
  vi.resetModules();
  vi.doMock('./internal-entry.ts', () => ({ resolveInternalEntryModulePath: () => null }));
  // Loaded after the reset so the client and the scope share one diagnostics module.
  const { countDiagnosticEventsByPhase, withDiagnosticsScope } =
    await import('@agent-device/host-kit/diagnostics');
  const { decodePngAsync, prewarmPngWorker } = await import('./png-worker-client.ts');
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));

  const prewarmed = await withDiagnosticsScope({ command: 'daemon' }, async () => {
    prewarmPngWorker();
    return countDiagnosticEventsByPhase(['png_worker_unavailable']);
  });
  const scopes = [];
  for (const label of ['first', 'second']) {
    scopes.push(
      await withDiagnosticsScope({ command: 'screenshot' }, async () => {
        await decodePngAsync(png, label);
        return countDiagnosticEventsByPhase(['png_worker_unavailable']);
      }),
    );
  }

  expect({ prewarmed, scopes }).toEqual({ prewarmed: 1, scopes: [1, 1] });
  vi.doUnmock('./internal-entry.ts');
});

test('a worker that dies under a request is reported in that request, not only the next one', async () => {
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
  const { countDiagnosticEventsByPhase, withDiagnosticsScope } =
    await import('@agent-device/host-kit/diagnostics');
  const { decodePngAsync, prewarmPngWorker } = await import('./png-worker-client.ts');
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  prewarmPngWorker();

  let jobStarted!: () => void;
  const started = new Promise<void>((resolve) => (jobStarted = resolve));
  const scoped = withDiagnosticsScope({ command: 'screenshot' }, async () => {
    const decoded = decodePngAsync(png, 'under-request');
    jobStarted();
    await decoded;
    return countDiagnosticEventsByPhase(['png_worker_unavailable']);
  });
  await started;
  // The worker's own error event carries no diagnostics scope.
  const worker = FakeWorker.last;
  if (!worker) throw new Error('the pre-warm did not start a worker');
  worker.emit('error', new Error('worker crashed'));

  expect(await scoped).toBe(1);
  vi.doUnmock('node:worker_threads');
});
