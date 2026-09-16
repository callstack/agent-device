import { expect, test, vi } from 'vitest';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createLimrunScreenRecordingOperations } from './recording-runtime.ts';
import { limrunIosSimulator } from './app-log-runtime.fixtures.ts';

const owner = providerRuntimeOwner('limrun', 'default');

function recorder(options: { finalize?: () => Promise<Record<string, never>> } = {}) {
  const calls: string[] = [];
  const session = {
    startRecording: vi.fn(async (start?: { quality?: number }) => {
      calls.push(`start:${start?.quality ?? 'default'}`);
    }),
    stopRecording: vi.fn(async ({ outPath }: { outPath: string }) => {
      calls.push(`stop:${outPath}`);
      return 'https://limrun.example/recording.mp4';
    }),
  };
  const host = {
    screenRecording: {
      outputs: {
        prepare: vi.fn(async () => {
          calls.push('prepare');
        }),
        copy: vi.fn(async () => {}),
        remove: vi.fn(async () => {
          calls.push('remove');
          return 'removed' as const;
        }),
      },
      finalize: {
        sniff: vi.fn(async () => {}),
        complete: vi.fn(async () => {
          calls.push('finalize');
          return await (options.finalize ?? (async () => ({})))();
        }),
      },
    },
  };
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

test('stop downloads the MP4 to the output path, finalizes it, and confirms the recorder', async () => {
  const { operations, calls } = recorder();
  const started = await operations.screenRecordingStart(input());

  const outcome = await started.pendingHandle.transfer().finish();

  expect(calls).toEqual(['prepare', 'start:5', 'stop:/tmp/limrun-recording.mp4', 'finalize']);
  expect(outcome).toMatchObject({
    status: 'completed',
    result: {
      backend: 'limrun-recorder',
      outPath: '/tmp/limrun-recording.mp4',
      stopObservation: { recorder: 'confirmed' },
    },
  });
});

test.each([
  [{ fps: 30 }, 'Limrun recordings do not support --fps'],
  [{ hideTouchesRequested: true }, 'Limrun recordings do not support --hide-touches'],
])(
  'refuses option %# before the output is touched or the instance records',
  async (override, message) => {
    const { operations, session, host } = recorder();

    await expect(operations.screenRecordingStart(input(override))).rejects.toThrow(message);

    expect(host.screenRecording.outputs.prepare).not.toHaveBeenCalled();
    expect(session.startRecording).not.toHaveBeenCalled();
  },
);

test('a device without a live provider session is refused before the output is prepared', async () => {
  const prepare = vi.fn(async () => {});
  const operations = createLimrunScreenRecordingOperations({
    host: {
      screenRecording: {
        outputs: { prepare, copy: async () => {}, remove: async () => 'removed' as const },
        finalize: { sniff: async () => {}, complete: async () => ({}) },
      },
    },
    device: limrunIosSimulator,
    owner,
    signal: new AbortController().signal,
    getDeviceSession: () => undefined,
  });

  await expect(operations.screenRecordingStart(input())).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
  });
  expect(prepare).not.toHaveBeenCalled();
});

test('a finalizer failure is not a completion, and cleanup stops the instance recorder once', async () => {
  const { operations, session, calls } = recorder({
    finalize: async () => {
      throw new Error('export is not a playable MP4');
    },
  });
  const started = await operations.screenRecordingStart(input());
  const handle = started.pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('export is not a playable MP4');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });

  expect(session.stopRecording).toHaveBeenCalledOnce();
  expect(calls.at(-1)).toBe('remove');
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
