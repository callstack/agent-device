import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { PNG } from './png.ts';

test('an unavailable worker is reported by the first diagnostics scope that reaches the fallback', async () => {
  vi.resetModules();
  vi.doMock('./internal-entry.ts', () => ({ resolveInternalEntryModulePath: () => null }));
  // Loaded after the reset so the client and the scope share one diagnostics module.
  const { countDiagnosticEventsByPhase, withDiagnosticsScope } =
    await import('@agent-device/host-kit/diagnostics');
  const { decodePngAsync, prewarmPngWorker } = await import('./png-worker-client.ts');
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));

  // The daemon pre-warms outside any request scope, where the report would be dropped.
  prewarmPngWorker();

  const reported = await withDiagnosticsScope({ command: 'screenshot' }, async () => {
    await decodePngAsync(png, 'first');
    const afterFirst = countDiagnosticEventsByPhase(['png_worker_unavailable']);
    await decodePngAsync(png, 'second');
    return { afterFirst, afterSecond: countDiagnosticEventsByPhase(['png_worker_unavailable']) };
  });
  const laterScope = await withDiagnosticsScope({ command: 'screenshot' }, async () => {
    await decodePngAsync(png, 'third');
    return countDiagnosticEventsByPhase(['png_worker_unavailable']);
  });

  expect(reported).toEqual({ afterFirst: 1, afterSecond: 1 });
  expect(laterScope).toBe(0);
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
  FakeWorker.last?.emit('error', new Error('worker crashed'));

  expect(await scoped).toBe(1);
  vi.doUnmock('node:worker_threads');
});
