import { beforeEach, expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { EncodedDurableDescriptor } from '@agent-device/contracts/durable-resource-envelope';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import {
  cleanupAndroidPerfCaptureDescriptor,
  inspectAndroidPerfCaptureDescriptor,
  startAndroidPerfCapture,
} from './platform-runtime-perf-capture-host.ts';

const androidNative = vi.hoisted(() => ({
  startAndroidSimpleperfProfile: vi.fn(),
  startAndroidPerfettoTrace: vi.fn(),
  stopAndroidSimpleperfProfile: vi.fn(),
  stopAndroidPerfettoTrace: vi.fn(),
  cleanupAndroidNativePerfSession: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', () => androidNative);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  androidNative.cleanupAndroidNativePerfSession.mockResolvedValue(undefined);
});

test('accepts only a fully decoded Android native capture descriptor', async () => {
  const valid = envelope({
    family: 'android',
    capture: {
      type: 'trace',
      kind: 'perfetto',
      packageName: 'com.example.app',
      appPid: '101',
      profilerPid: '202',
      remotePath: '/data/misc/perfetto-traces/app.trace',
      outPath: '/tmp/app.trace',
      startedAt: 1,
      state: 'running',
    },
  });
  await expect(inspectAndroidPerfCaptureDescriptor(valid)).resolves.toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  await expect(cleanupAndroidPerfCaptureDescriptor(device, valid)).resolves.toEqual({
    status: 'cleaned',
  });

  const malformed = envelope({
    family: 'android',
    capture: {
      type: 'trace',
      kind: 'perfetto',
      packageName: 'com.example.app',
      appPid: '101',
      profilerPid: '202',
      outPath: '/tmp/app.trace',
      startedAt: 1,
      state: 'running',
    },
  });
  await expect(inspectAndroidPerfCaptureDescriptor(malformed)).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(cleanupAndroidPerfCaptureDescriptor(device, malformed)).resolves.toEqual({
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
  });
});

test('starts, retargets, finishes, and cleans a Simpleperf profile through one live handle', async () => {
  const capture = androidCapture({ kind: 'simpleperf', type: 'cpu-profile' });
  androidNative.startAndroidSimpleperfProfile.mockResolvedValue(capture);
  androidNative.stopAndroidSimpleperfProfile.mockImplementation(
    async (_device: DeviceInfo, current: typeof capture, outPath: string) => ({
      ...current,
      action: 'stop',
      state: 'stopped',
      outPath,
      stoppedAt: 2,
      durationMs: 1,
      summary: { samples: 3 },
    }),
  );

  const started = await startAndroidPerfCapture(
    device,
    localRuntimeOwner('android'),
    captureInput({ kind: 'simpleperf', mode: 'cpu-profile' }),
  );
  expect(started.response).toMatchObject({
    kind: 'simpleperf',
    mode: 'cpu-profile',
    state: 'running',
  });
  await expect(inspectAndroidPerfCaptureDescriptor(started.envelope)).resolves.toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });

  const handle = started.pendingHandle.transfer();
  handle.setOutputPath('/tmp/retargeted.data');
  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: { kind: 'simpleperf', state: 'stopped', outPath: '/tmp/retargeted.data' },
  });
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(androidNative.stopAndroidSimpleperfProfile).toHaveBeenCalledWith(
    device,
    capture,
    '/tmp/retargeted.data',
  );
  expect(androidNative.cleanupAndroidNativePerfSession).toHaveBeenCalledTimes(1);
});

test('starts and finishes an Android Perfetto trace', async () => {
  const capture = androidCapture({ kind: 'perfetto', type: 'trace' });
  androidNative.startAndroidPerfettoTrace.mockResolvedValue(capture);
  androidNative.stopAndroidPerfettoTrace.mockResolvedValue({
    ...capture,
    action: 'stop',
    state: 'stopped',
    stoppedAt: 3,
    durationMs: 2,
    summary: { packets: 4 },
  });

  const started = await startAndroidPerfCapture(
    device,
    localRuntimeOwner('android'),
    captureInput({ kind: 'perfetto', mode: 'trace' }),
  );
  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
    result: { kind: 'perfetto', mode: 'trace', state: 'stopped' },
  });
  expect(androidNative.startAndroidPerfettoTrace).toHaveBeenCalledWith(
    device,
    'com.example.app',
    '/tmp/capture',
  );
});

function androidCapture(input: { kind: 'simpleperf' | 'perfetto'; type: 'cpu-profile' | 'trace' }) {
  return {
    action: 'start' as const,
    ...input,
    packageName: 'com.example.app',
    appPid: '101',
    profilerPid: '202',
    remotePath: '/data/local/tmp/capture',
    outPath: '/tmp/capture',
    startedAt: 1,
    state: 'running' as const,
    method: 'native',
    message: 'started',
  };
}

function captureInput(input: { kind: 'simpleperf' | 'perfetto'; mode: 'cpu-profile' | 'trace' }) {
  return {
    sessionId: 'one',
    appId: 'com.example.app',
    ...input,
    outPath: '/tmp/capture',
    fence: { token: 'fence', generation: 1 },
  } as const;
}

function envelope(body: EncodedDurableDescriptor['body']) {
  return createDurableResourceEnvelope({
    resourceKind: 'perf-capture',
    sessionId: 'one',
    device: deviceIdentity(device),
    owner: localRuntimeOwner('android'),
    fence: { token: 'fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body },
  });
}
