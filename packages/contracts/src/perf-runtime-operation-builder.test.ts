import { expect, test, vi } from 'vitest';
import type { PerfRuntimeOperations } from './perf-runtime.ts';
import {
  createPerfNativeOperations,
  missingPerfAppMetric,
  missingPerfSnapshotAppError,
  settlePerfMetric,
  unsupportedPerfMemoryArtifact,
} from './perf-runtime-operation-builder.ts';

test('builds compact unavailable observations and memory-artifact guidance', async () => {
  await expect(settlePerfMetric(Promise.reject(new Error('sample failed')))).resolves.toMatchObject(
    {
      available: false,
      reason: 'sample failed',
    },
  );
  expect(missingPerfAppMetric('Apple', 'bundle ID')).toMatchObject({
    available: false,
    reason: expect.stringContaining('Run open <app> first'),
  });
  expect(unsupportedPerfMemoryArtifact('Apple', 'android-hprof', {}, 'Use memgraph')).toEqual({
    artifact: {
      available: false,
      kind: 'android-hprof',
      reason: 'Apple perf memory snapshot does not support android-hprof.',
      hint: 'Use memgraph',
      support: {},
    },
    support: {},
  });
  expect(missingPerfSnapshotAppError()).toMatchObject({ code: 'INVALID_ARGS' });
});

test('delegates a valid native profile report', async () => {
  const writeProfileReport = vi.fn(async () => ({ report: true }));
  const unused = vi.fn() as unknown as PerfRuntimeOperations['perfNativeCaptureStart'];
  const operations = createPerfNativeOperations({
    platform: 'Apple',
    expectedProfileKind: 'xctrace',
    start: unused,
    reattach: vi.fn() as unknown as PerfRuntimeOperations['perfNativeCaptureReattach'],
    cleanup: vi.fn() as unknown as PerfRuntimeOperations['perfNativeCaptureCleanup'],
    writeProfileReport,
  });

  await expect(
    operations.perfProfileReport({
      kind: 'xctrace',
      tracePath: '/tmp/profile.trace',
      outPath: '/tmp/report.json',
    }),
  ).resolves.toEqual({ report: true });
  expect(writeProfileReport).toHaveBeenCalledOnce();
});
