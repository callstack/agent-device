import { expect, test, vi } from 'vitest';
import type { ApplePerfHost } from '@agent-device/contracts/perf-runtime-host';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createApplePerfOperations } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device',
  name: 'iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('owns Apple frame observation policy and delegates only native sampling', async () => {
  const sampleFrames = vi.fn(async () => ({ droppedFramePercent: 3 }));
  const operations = createApplePerfOperations({
    resolveHost: () =>
      ({
        sampleFrames,
        frameSampling: async () => ({ method: 'xctrace-display' }),
      }) as unknown as ApplePerfHost,
    device,
    owner: localRuntimeOwner('apple'),
  });

  await expect(operations.perfFrames({ appId: 'com.example.app' })).resolves.toEqual({
    metric: { available: true, droppedFramePercent: 3 },
    sampling: { method: 'xctrace-display' },
  });
  expect(sampleFrames).toHaveBeenCalledWith(device, 'com.example.app');
});

test('refuses non-Apple profile kinds before invoking the report host', async () => {
  const writeProfileReport = vi.fn();
  const operations = createApplePerfOperations({
    resolveHost: () => ({ writeProfileReport }) as unknown as ApplePerfHost,
    device,
    owner: localRuntimeOwner('apple'),
  });

  await expect(
    operations.perfProfileReport({
      kind: 'simpleperf',
      tracePath: '/tmp/cpu.data',
      outPath: '/tmp/report.json',
    }),
  ).rejects.toThrow('Apple native perf requires --kind xctrace');
  expect(writeProfileReport).not.toHaveBeenCalled();
});

test('returns compact unavailable observations when the app is missing or sampling fails', async () => {
  const operations = createApplePerfOperations({
    resolveHost: () =>
      ({
        frameSampling: async () => ({ method: 'xctrace-display' }),
        sampleMemory: async () => {
          throw new Error('memory probe failed');
        },
        memorySampling: async () => ({ method: 'xctrace-memory' }),
      }) as unknown as ApplePerfHost,
    device,
    owner: localRuntimeOwner('apple'),
  });

  await expect(operations.perfFrames({})).resolves.toMatchObject({
    metric: { available: false, reason: expect.stringContaining('Run open <app> first') },
  });
  await expect(operations.perfMemorySample({ appId: 'com.example.app' })).resolves.toMatchObject({
    metric: { available: false, reason: 'memory probe failed' },
    sampling: { method: 'xctrace-memory' },
  });
});

test('owns Apple memory snapshot support, rejection, and output naming', async () => {
  const captureMemorySnapshot = vi.fn(async (_device, _appId, outPath) => ({ path: outPath }));
  const operations = createApplePerfOperations({
    resolveHost: () =>
      ({
        memorySnapshotSupport: async () => ({ platform: 'apple', memgraph: true }),
        captureMemorySnapshot,
      }) as unknown as ApplePerfHost,
    device,
    owner: localRuntimeOwner('apple'),
  });

  await expect(
    operations.perfMemorySnapshot({
      appId: 'com.example.app',
      kind: 'android-hprof',
      artifactsDir: '/tmp/artifacts',
    }),
  ).resolves.toMatchObject({ artifact: { available: false, kind: 'android-hprof' } });
  await expect(
    operations.perfMemorySnapshot({
      appId: 'com.example.app',
      kind: 'memgraph',
      artifactsDir: '/tmp/artifacts',
    }),
  ).resolves.toMatchObject({
    artifact: { path: expect.stringMatching(/memory-memgraph-.*\.memgraph/) },
  });
  expect(captureMemorySnapshot).toHaveBeenCalledWith(
    device,
    'com.example.app',
    expect.stringMatching(/^\/tmp\/artifacts\/memory-memgraph-.*\.memgraph$/),
  );
});

test('forwards each native lifecycle operation through the Apple host', async () => {
  const host = {
    start: vi.fn(async () => ({ started: true })),
    reattach: vi.fn(async () => ({ status: 'missing' })),
    cleanup: vi.fn(async () => ({ status: 'cleaned' })),
    writeProfileReport: vi.fn(async () => ({ report: true })),
  } as unknown as ApplePerfHost;
  const operations = createApplePerfOperations({
    resolveHost: () => host,
    device,
    owner: localRuntimeOwner('apple'),
  });

  await operations.perfNativeCaptureStart({
    sessionId: 'one',
    appId: 'com.example.app',
    mode: 'cpu-profile',
    kind: 'xctrace',
    outPath: '/tmp/profile.trace',
    fence: { token: 'fence', generation: 1 },
  });
  await operations.perfNativeCaptureReattach({} as never);
  await operations.perfNativeCaptureCleanup({} as never);
  await operations.perfProfileReport({
    kind: 'xctrace',
    tracePath: '/tmp/profile.trace',
    outPath: '/tmp/report.json',
  });

  expect(host.start).toHaveBeenCalledOnce();
  expect(host.reattach).toHaveBeenCalledOnce();
  expect(host.cleanup).toHaveBeenCalledOnce();
  expect(host.writeProfileReport).toHaveBeenCalledOnce();
});
