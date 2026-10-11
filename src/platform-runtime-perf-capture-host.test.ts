import { beforeEach, expect, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { EncodedDurableDescriptor } from '@agent-device/contracts/durable-resource-envelope';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import {
  cleanupAndroidPerfCaptureDescriptor,
  cleanupApplePerfCaptureDescriptor,
  inspectAndroidPerfCaptureDescriptor,
  inspectApplePerfCaptureDescriptor,
  startAndroidPerfCapture,
  startApplePerfCapture,
} from './platform-runtime-perf-capture-host.ts';
import { IOS_SIMULATOR } from './__tests__/test-utils/device-fixtures.ts';

const androidNative = vi.hoisted(() => ({
  startAndroidSimpleperfProfile: vi.fn(),
  startAndroidPerfettoTrace: vi.fn(),
  stopAndroidSimpleperfProfile: vi.fn(),
  stopAndroidPerfettoTrace: vi.fn(),
  cleanupAndroidNativePerfSession: vi.fn(),
}));

const appleXctrace = vi.hoisted(() => ({
  startAppleXctracePerfCapture: vi.fn(),
  stopAppleXctracePerfCapture: vi.fn(),
  cleanupAppleXctracePerfCapture: vi.fn(),
}));

const processHost = vi.hoisted(() => ({
  resolveManagedProcessIdentity: vi.fn(),
  inspectManagedProcess: vi.fn(),
  terminateManagedProcessSet: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', () => androidNative);
vi.mock('@agent-device/platform-apple/perf', () => appleXctrace);
vi.mock('./platform-runtime-screen-recording-process-host.ts', () => processHost);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const appleDevice = IOS_SIMULATOR;

const appleMarker = Object.freeze({
  pid: 4210,
  startTime: 'Fri Oct 02 09:00:00 2026',
  command: 'xcrun xctrace record --template Time Profiler',
});

beforeEach(() => {
  vi.clearAllMocks();
  androidNative.cleanupAndroidNativePerfSession.mockResolvedValue(undefined);
  appleXctrace.cleanupAppleXctracePerfCapture.mockResolvedValue({
    code: 0,
    stdout: '',
    stderr: '',
  });
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

test('starts, retargets, stops, and reclaims an Apple xctrace capture through one live handle', async () => {
  const capture = appleCapture({ mode: 'trace', template: 'Animation Hitches' });
  appleXctrace.startAppleXctracePerfCapture.mockResolvedValue(capture);
  appleXctrace.stopAppleXctracePerfCapture.mockImplementation(
    async (current: typeof capture, outPath: string) => ({
      ...stripAppleChild(current),
      outPath,
      endedAt: '2026-10-02T09:01:00.000Z',
    }),
  );
  processHost.resolveManagedProcessIdentity.mockResolvedValue(appleMarker);
  processHost.inspectManagedProcess.mockReturnValue('owned-alive');
  processHost.terminateManagedProcessSet.mockResolvedValue('terminated');

  const started = await startApplePerfCapture(
    appleDevice,
    localRuntimeOwner('apple'),
    captureInput({ kind: 'xctrace', mode: 'trace', template: 'Animation Hitches' }),
  );
  expect(appleXctrace.startAppleXctracePerfCapture).toHaveBeenCalledWith({
    device: appleDevice,
    appBundleId: 'com.example.app',
    mode: 'trace',
    template: 'Animation Hitches',
    outPath: '/tmp/capture',
  });
  expect(started.response).toMatchObject({ perf: 'started', kind: 'xctrace', mode: 'trace' });

  const handle = started.pendingHandle.transfer();
  handle.setOutputPath('/tmp/retargeted.trace');
  await expect(handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: { perf: 'stopped', outPath: '/tmp/retargeted.trace', endedAt: expect.any(String) },
  });

  await expect(inspectApplePerfCaptureDescriptor(started.envelope)).resolves.toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  await expect(cleanupApplePerfCaptureDescriptor(started.envelope)).resolves.toEqual({
    status: 'cleaned',
  });
  expect(processHost.terminateManagedProcessSet).toHaveBeenCalledWith([appleMarker]);
});

test('derives the xctrace template from the capture mode', async () => {
  appleXctrace.startAppleXctracePerfCapture.mockResolvedValue(
    appleCapture({ mode: 'cpu-profile', template: 'Time Profiler' }),
  );
  processHost.resolveManagedProcessIdentity.mockResolvedValue(appleMarker);

  await startApplePerfCapture(
    appleDevice,
    localRuntimeOwner('apple'),
    captureInput({ kind: 'xctrace', mode: 'cpu-profile' }),
  );
  expect(appleXctrace.startAppleXctracePerfCapture).toHaveBeenLastCalledWith(
    expect.objectContaining({ template: 'Time Profiler' }),
  );

  await startApplePerfCapture(
    appleDevice,
    localRuntimeOwner('apple'),
    captureInput({ kind: 'xctrace', mode: 'trace' }),
  );
  expect(appleXctrace.startAppleXctracePerfCapture).toHaveBeenLastCalledWith(
    expect.objectContaining({ template: 'Animation Hitches' }),
  );
});

test('rejects a non-xctrace native kind for an Apple capture', async () => {
  await expect(
    startApplePerfCapture(
      appleDevice,
      localRuntimeOwner('apple'),
      captureInput({ kind: 'perfetto', mode: 'trace' }),
    ),
  ).rejects.toThrow('Apple native perf requires --kind xctrace, not perfetto');
  expect(appleXctrace.startAppleXctracePerfCapture).not.toHaveBeenCalled();
});

test('reclaims the profiler when Apple exposes no exact process identity', async () => {
  const capture = appleCapture({ mode: 'cpu-profile', template: 'Time Profiler' });
  appleXctrace.startAppleXctracePerfCapture.mockResolvedValue({
    ...capture,
    child: { pid: undefined },
  });
  processHost.resolveManagedProcessIdentity.mockResolvedValue(undefined);

  await expect(
    startApplePerfCapture(
      appleDevice,
      localRuntimeOwner('apple'),
      captureInput({ kind: 'xctrace', mode: 'cpu-profile' }),
    ),
  ).rejects.toThrow('Apple xctrace exposed no exact process identity');
  expect(processHost.resolveManagedProcessIdentity).toHaveBeenCalledWith(undefined);
  expect(appleXctrace.cleanupAppleXctracePerfCapture).toHaveBeenCalledTimes(1);
});

test('maps each managed-process outcome through Apple descriptor cleanup', async () => {
  const envelope = appleEnvelope();
  const cases: Array<
    Readonly<{
      ownership: 'ownership-lost' | 'missing' | 'owned-alive';
      terminated?: 'terminated' | 'already-missing' | 'ownership-lost';
      expected: { status: string; reason?: string };
    }>
  > = [
    {
      ownership: 'ownership-lost',
      expected: { status: 'cleanup-pending', reason: 'ownership-fence-lost' },
    },
    { ownership: 'missing', expected: { status: 'already-missing' } },
    {
      ownership: 'owned-alive',
      terminated: 'terminated',
      expected: { status: 'cleaned' },
    },
    {
      ownership: 'owned-alive',
      terminated: 'already-missing',
      expected: { status: 'already-missing' },
    },
    {
      ownership: 'owned-alive',
      terminated: 'ownership-lost',
      expected: { status: 'cleanup-pending', reason: 'ownership-fence-lost' },
    },
  ];
  for (const testCase of cases) {
    processHost.inspectManagedProcess.mockReturnValueOnce(testCase.ownership);
    if (testCase.terminated !== undefined) {
      processHost.terminateManagedProcessSet.mockResolvedValueOnce(testCase.terminated);
    }
    await expect(cleanupApplePerfCaptureDescriptor(envelope)).resolves.toEqual(testCase.expected);
  }
  expect(processHost.terminateManagedProcessSet).toHaveBeenCalledTimes(3);
});

test('maps each managed-process outcome through Apple descriptor reattach', async () => {
  const envelope = appleEnvelope();
  processHost.inspectManagedProcess
    .mockReturnValueOnce('missing')
    .mockReturnValueOnce('owned-alive')
    .mockReturnValueOnce('ownership-lost');
  await expect(inspectApplePerfCaptureDescriptor(envelope)).resolves.toEqual({
    status: 'missing',
  });
  await expect(inspectApplePerfCaptureDescriptor(envelope)).resolves.toEqual({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  await expect(inspectApplePerfCaptureDescriptor(envelope)).resolves.toEqual({
    status: 'unreattachable',
    reason: 'ownership-fence-lost',
  });
});

test('refuses Apple descriptor recovery for an undecodable or foreign body', async () => {
  const malformed = [
    { ...appleBody(), capture: 'not-a-capture' },
    { ...appleBody(), capture: { ...appleBody().capture, kind: 'perfetto' } },
    { ...appleBody(), capture: { ...appleBody().capture, mode: 'time' } },
    {
      ...appleBody(),
      capture: (() => {
        const { template: _template, ...capture } = appleBody().capture;
        return capture;
      })(),
    },
    { ...appleBody(), capture: { ...appleBody().capture, platform: 'apple' } },
    { ...appleBody(), capture: { ...appleBody().capture, targetProcesses: [42] } },
    { ...appleBody(), capture: { ...appleBody().capture, targetPids: ['12'] } },
    { ...appleBody(), marker: { pid: 1 } },
  ];
  for (const body of malformed) {
    await expect(inspectApplePerfCaptureDescriptor(envelope(body))).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'descriptor-invalid',
    });
    await expect(cleanupApplePerfCaptureDescriptor(envelope(body))).resolves.toEqual({
      status: 'cleanup-pending',
      reason: 'manual-recovery-required',
    });
  }

  const androidBody = {
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
  };
  await expect(inspectApplePerfCaptureDescriptor(envelope(androidBody))).resolves.toEqual({
    status: 'unreattachable',
    reason: 'descriptor-invalid',
  });
  await expect(cleanupApplePerfCaptureDescriptor(envelope(androidBody))).resolves.toEqual({
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
  });

  processHost.inspectManagedProcess.mockReturnValue('missing');
  await expect(
    inspectApplePerfCaptureDescriptor(
      envelope({ ...appleBody(), capture: { ...appleBody().capture, mode: 'trace' } }),
    ),
  ).resolves.toEqual({ status: 'missing' });
});

function appleCapture(input: {
  mode: 'cpu-profile' | 'trace';
  template: string;
}): import('@agent-device/platform-apple/perf').AppleXctracePerfCapture {
  return {
    kind: 'xctrace',
    ...input,
    outPath: '/tmp/capture',
    appBundleId: 'com.example.app',
    deviceId: appleDevice.id,
    platform: 'ios',
    targetPids: [42],
    targetProcesses: ['com.example.app'],
    startedAt: '2026-10-02T09:00:00.000Z',
    child: { pid: appleMarker.pid } as unknown as AppleChild,
    wait: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  } as unknown as import('@agent-device/platform-apple/perf').AppleXctracePerfCapture;
}

type AppleChild = import('@agent-device/platform-apple/perf').AppleXctracePerfCapture['child'];

function stripAppleChild(
  capture: import('@agent-device/platform-apple/perf').AppleXctracePerfCapture,
) {
  const { child: _child, wait: _wait, ...rest } = capture;
  return rest;
}

function appleBody() {
  return {
    family: 'apple',
    marker: { ...appleMarker },
    capture: {
      kind: 'xctrace',
      mode: 'cpu-profile',
      template: 'Time Profiler',
      outPath: '/tmp/capture.trace',
      appBundleId: 'com.example.app',
      deviceId: appleDevice.id,
      platform: 'ios',
      targetPids: [42],
      targetProcesses: ['com.example.app'],
      startedAt: '2026-10-02T09:00:00.000Z',
    },
  };
}

function appleEnvelope() {
  return envelope(appleBody());
}

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

function captureInput(input: {
  kind: 'simpleperf' | 'perfetto' | 'xctrace';
  mode: 'cpu-profile' | 'trace';
  template?: string;
}) {
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
