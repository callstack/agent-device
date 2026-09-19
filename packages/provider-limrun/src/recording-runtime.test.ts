import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';
import {
  limrunIosSimulator,
  limrunOwnerOptions,
  limrunScope,
  unusedLimrunHost,
} from './app-log-runtime.fixtures.ts';
import {
  createLimrunScreenRecordingOperations,
  type LimrunScreenRecordingSession,
} from './recording-runtime.ts';

const owner = providerRuntimeOwner('limrun', 'default');
const DOWNLOAD_URL = 'https://limrun.example/v1/instance/api/files?name=recording.mp4';

function fakeSession(calls: string[], options: { failDownloads?: number } = {}) {
  let downloadsFailed = 0;
  const session = {
    startRecording: vi.fn(async (start?: { quality?: number }) => {
      calls.push(`start:${start?.quality ?? 'default'}`);
    }),
    stopRecording: vi.fn(async () => {
      calls.push('stop');
      return { downloadUrl: DOWNLOAD_URL };
    }),
    downloadRecording: vi.fn(async (input: { downloadUrl: string; outPath: string }) => {
      if (downloadsFailed < (options.failDownloads ?? 0)) {
        downloadsFailed += 1;
        calls.push('download:failed');
        throw new Error('download dropped');
      }
      calls.push(`download:${input.outPath}`);
    }),
  } satisfies LimrunScreenRecordingSession;
  return session;
}

function fakeRecordingHost(calls: string[], finalize?: () => Promise<Record<string, never>>) {
  return {
    screenRecording: {
      outputs: {
        prepare: vi.fn(async () => {
          calls.push('prepare');
        }),
        copy: vi.fn(async () => {}),
        remove: vi.fn(async () => 'removed' as const),
      },
      finalize: {
        sniff: vi.fn(async () => {}),
        complete: vi.fn(async () => {
          calls.push('finalize');
          return await (finalize ?? (async () => ({})))();
        }),
      },
    },
  };
}

function recorder(
  options: { failDownloads?: number; finalize?: () => Promise<Record<string, never>> } = {},
) {
  const calls: string[] = [];
  const session = fakeSession(calls, options);
  const host = fakeRecordingHost(calls, options.finalize);
  const operations = createLimrunScreenRecordingOperations({
    host,
    device: limrunIosSimulator,
    owner,
    signal: new AbortController().signal,
    getDeviceSession: () => session,
  });
  return { operations, session, host, calls };
}

function input(overrides: Partial<ScreenRecordingStartInput> = {}): ScreenRecordingStartInput {
  return {
    sessionId: 'lp-verify',
    outputPath: '/tmp/limrun-recording.mp4',
    scope: 'app',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence', generation: 1 },
    ...overrides,
  };
}

test('start prepares the output, then asks the instance to record at the medium preset', async () => {
  const { operations, calls } = recorder();

  const started = await operations.screenRecordingStart(input());

  expect(calls).toEqual(['prepare', 'start:5']);
  expect(started.envelope.descriptor.body).toMatchObject({
    backend: 'limrun-recorder',
    outputPath: '/tmp/limrun-recording.mp4',
  });
  expect(started.pendingHandle.transfer().inspect()).toMatchObject({
    backend: 'limrun-recorder',
    outPath: '/tmp/limrun-recording.mp4',
    scope: 'app',
    showTouches: false,
  });
});

test('the high preset maps onto the low end of the legacy high band', async () => {
  const { operations, session } = recorder();

  await operations.screenRecordingStart(input({ exportQuality: 'high' }));

  expect(session.startRecording).toHaveBeenCalledWith({ quality: 8 });
});

test('stop asks the instance once, downloads the served MP4 to the output path, finalizes, and confirms the recorder', async () => {
  const { operations, calls, session } = recorder();
  const started = await operations.screenRecordingStart(input());

  const outcome = await started.pendingHandle.transfer().finish();

  expect(calls).toEqual([
    'prepare',
    'start:5',
    'stop',
    'download:/tmp/limrun-recording.mp4',
    'finalize',
  ]);
  expect(session.downloadRecording).toHaveBeenCalledWith(
    expect.objectContaining({
      downloadUrl: DOWNLOAD_URL,
      outPath: '/tmp/limrun-recording.mp4',
    }),
  );
  expect(outcome).toMatchObject({
    status: 'completed',
    result: {
      backend: 'limrun-recorder',
      outPath: '/tmp/limrun-recording.mp4',
      stopObservation: { recorder: 'confirmed' },
    },
  });
});

test('a download that fails after the instance stopped is retried by the next stop without a second remote stop', async () => {
  const { operations, calls, session } = recorder({ failDownloads: 1 });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('download dropped');
  await expect(handle.finish()).resolves.toMatchObject({ status: 'completed' });

  expect(session.stopRecording).toHaveBeenCalledOnce();
  expect(calls).toEqual([
    'prepare',
    'start:5',
    'stop',
    'download:failed',
    'download:/tmp/limrun-recording.mp4',
    'finalize',
  ]);
});

test.each([
  [{ fps: 30 }, 'Limrun recordings do not support --fps'],
  [{ hideTouchesRequested: true }, 'Limrun recordings do not support --hide-touches'],
])(
  'refuses option %# with a typed error before the output is touched or the instance records',
  async (override, message) => {
    const { operations, session, host } = recorder();

    await expect(operations.screenRecordingStart(input(override))).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message,
    });

    expect(host.screenRecording.outputs.prepare).not.toHaveBeenCalled();
    expect(session.startRecording).not.toHaveBeenCalled();
  },
);

test('a device without a live provider session is refused before the output is prepared', async () => {
  const calls: string[] = [];
  const host = fakeRecordingHost(calls);
  const operations = createLimrunScreenRecordingOperations({
    host,
    device: limrunIosSimulator,
    owner,
    signal: new AbortController().signal,
    getDeviceSession: () => undefined,
  });

  await expect(operations.screenRecordingStart(input())).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  expect(host.screenRecording.outputs.prepare).not.toHaveBeenCalled();
});

test('a finalizer failure is not a completion; cleanup stops the instance once and never downloads', async () => {
  const { operations, session, calls } = recorder({
    finalize: async () => {
      throw new Error('export is not a playable MP4');
    },
  });
  const handle = (await operations.screenRecordingStart(input())).pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('export is not a playable MP4');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });

  expect(session.stopRecording).toHaveBeenCalledOnce();
  expect(session.downloadRecording).toHaveBeenCalledOnce();
  expect(calls.at(-1)).toBe('finalize');
});

test('recordings are neither reattachable nor cleanable after a daemon restart', async () => {
  const { operations } = recorder();
  const envelope = (await operations.screenRecordingStart(input())).envelope;

  await expect(operations.screenRecordingReattach({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
  });
  await expect(operations.screenRecordingCleanup({ envelope })).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
  });
});

test('the bound owner serves record start and stop through the live device session', async () => {
  const calls: string[] = [];
  const session = fakeSession(calls);
  const host = {
    ...unusedLimrunHost(),
    screenRecording: fakeRecordingHost(calls).screenRecording,
  } as unknown as PlatformRuntimeHost;
  const runtimeOwner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({ host, getDeviceSession: () => session }),
  );
  const binding = await runtimeOwner.bind({
    device: limrunIosSimulator,
    intent: { kind: 'ordinary' },
    scope: limrunScope,
  });

  expect(binding.facts.operations.screenRecordingStart).toEqual({ available: true });
  const started = await binding.operations.screenRecordingStart?.(input({ exportQuality: 'high' }));
  if (!started) throw new Error('the bound owner did not serve screenRecordingStart');
  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
    result: { backend: 'limrun-recorder', stopObservation: { recorder: 'confirmed' } },
  });
  expect(calls).toEqual([
    'prepare',
    'start:8',
    'stop',
    'download:/tmp/limrun-recording.mp4',
    'finalize',
  ]);
});
