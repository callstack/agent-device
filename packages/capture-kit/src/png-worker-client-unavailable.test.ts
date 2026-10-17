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
