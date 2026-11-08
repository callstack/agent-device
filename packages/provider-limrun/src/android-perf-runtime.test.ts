import { expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';
import { limrunOwnerOptions, limrunScope } from './app-log-runtime.fixtures.ts';
import { createLimrunAndroidPerfOperations } from './android-perf-runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'limrun:android:reads',
  name: 'Limrun Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('a live Android owner binds reads and rejects a lease lost after binding', async () => {
  let live = true;
  const perfFrames = vi.fn(async () => ({ metric: { available: true, totalFrameCount: 100 } }));
  const perfMemorySnapshot = vi.fn(async () => ({
    artifact: { available: true, path: '/tmp/artifacts/heap.hprof' },
  }));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      hasLiveSession: () => live,
      getInteractor: () =>
        live
          ? ({ readTextAtPoint: async () => 'current field value' } as unknown as Interactor)
          : undefined,
      bindPerformance: async () =>
        live
          ? {
              perfFrames,
              perfMemorySample: async () => ({ metric: { available: true, totalPssKb: 512 } }),
              perfMemorySnapshot,
            }
          : undefined,
    }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope: limrunScope });
  for (const operation of [
    'readTextAtPoint',
    'perfFrames',
    'perfMemorySample',
    'perfMemorySnapshot',
  ] as const) {
    expect(binding.facts.operations[operation]).toEqual({ available: true });
    expect(binding.operations[operation]).toBeTypeOf('function');
  }
  expect(binding.facts.operations.perfNativeCaptureStart.available).toBe(false);
  expect(binding.operations.perfNativeCaptureStart).toBeUndefined();
  await expect(binding.operations.readTextAtPoint!({ point: { x: 10, y: 20 } })).resolves.toEqual({
    status: 'read',
    text: 'current field value',
  });
  await expect(
    binding.operations.perfMemorySample!({ appId: 'com.example.app' }),
  ).resolves.toMatchObject({ metric: { totalPssKb: 512 } });
  await expect(binding.operations.perfFrames!({ appId: 'com.example.app' })).resolves.toMatchObject(
    {
      metric: { available: true, totalFrameCount: 100 },
    },
  );
  expect(perfFrames).toHaveBeenCalledWith({ appId: 'com.example.app' });
  const snapshotInput = {
    appId: 'com.example.app',
    kind: 'android-hprof' as const,
    artifactsDir: '/tmp/artifacts',
    outPath: '/tmp/artifacts/heap.hprof',
  };
  await expect(binding.operations.perfMemorySnapshot!(snapshotInput)).resolves.toMatchObject({
    artifact: { available: true, path: '/tmp/artifacts/heap.hprof' },
  });
  expect(perfMemorySnapshot).toHaveBeenCalledWith(snapshotInput);
  live = false;
  await expect(
    binding.operations.readTextAtPoint!({ point: { x: 10, y: 20 } }),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  await expect(binding.operations.readClipboard!({})).rejects.toMatchObject({
    code: 'DEVICE_NOT_FOUND',
  });
  await expect(
    binding.operations.perfMemorySample!({ appId: 'com.example.app' }),
  ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  expect((await owner.inspectFacts(device)).operations.perfMemorySample.available).toBe(false);
  await expect(
    owner.bind({ device, intent: { kind: 'ordinary' }, scope: limrunScope }),
  ).rejects.toMatchObject({ details: { reason: 'provider-session-unavailable' } });
  await binding[Symbol.asyncDispose]();
});

test('cancellation while binding prevents a performance operation from starting', async () => {
  const controller = new AbortController();
  const perfMemorySnapshot = vi.fn();
  const reason = new Error('Canceled during binding');
  const runtime = createLimrunAndroidPerfOperations(async () => {
    controller.abort(reason);
    return { perfFrames: vi.fn(), perfMemorySample: vi.fn(), perfMemorySnapshot };
  }, controller.signal);
  const capture = runtime.perfMemorySnapshot({
    appId: 'com.example.app',
    artifactsDir: '/tmp/artifacts',
  });
  await expect(capture).rejects.toBe(reason);
  expect(perfMemorySnapshot).not.toHaveBeenCalled();
});
