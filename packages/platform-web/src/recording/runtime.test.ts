import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test, vi } from 'vitest';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/platform';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { bindWebScreenRecordingRuntime } from './runtime.ts';

const device = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

test.each([
  [{ recordOnlySession: true }, 'record on web requires an active browser session'],
  [{ scope: 'device' as const }, 'web recordings do not support --scope'],
  [{ fps: 30 }, 'web recordings do not support --fps'],
  [{ exportQuality: 'high' as const }, 'web recordings do not support --quality'],
  [{ hideTouchesRequested: true }, 'web recordings do not support --hide-touches'],
])(
  'rejects web recording option %# before the browser recorder starts',
  async (override, message) => {
    let starts = 0;
    const recording = await runtime({
      start: async () => {
        starts += 1;
      },
      stop: async () => {},
    });
    await expect(
      recording.operations.screenRecordingStart?.({ ...input(), ...override }),
    ).rejects.toThrow(message);
    expect(starts).toBe(0);
  },
);

test('does not report completion when the browser stop or finalizer fails', async () => {
  const stopFailure = await runtime({
    start: async () => {},
    stop: async () => {
      throw new Error('browser stop failed');
    },
  });
  const started = await stopFailure.operations.screenRecordingStart?.(input());
  if (!started) throw new Error('missing recording operation');
  await expect(started.pendingHandle.transfer().finish()).rejects.toThrow('browser stop failed');

  const finalizerFailure = await runtime(
    { start: async () => {}, stop: async () => {} },
    async () => {
      throw new Error('finalizer failed');
    },
  );
  const second = await finalizerFailure.operations.screenRecordingStart?.(input());
  if (!second) throw new Error('missing recording operation');
  await expect(second.pendingHandle.transfer().finish()).rejects.toThrow('finalizer failed');
});

test('rolls back an acquired browser recorder when setup is cancelled', async () => {
  const controller = new AbortController();
  const reason = new Error('request cancelled');
  let stops = 0;
  const recording = await runtime(
    {
      start: async () => controller.abort(reason),
      stop: async () => {
        stops += 1;
      },
    },
    undefined,
    controller.signal,
  );

  await expect(recording.operations.screenRecordingStart?.(input())).rejects.toBe(reason);
  expect(stops).toBe(1);
});

test('does not stop a browser recorder that failed before acquisition', async () => {
  const startFailure = new Error('browser recorder unavailable');
  const stop = vi.fn(async () => {});
  const recording = await runtime({
    start: async () => {
      throw startFailure;
    },
    stop,
  });

  await expect(recording.operations.screenRecordingStart?.(input())).rejects.toBe(startFailure);
  expect(stop).not.toHaveBeenCalled();
});

test('validates options before destructive output preparation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-device-web-recording-'));
  const outputPath = join(directory, 'capture.webm');
  await writeFile(outputPath, 'existing recording');
  let preparations = 0;
  const recording = await runtime(
    { start: async () => {}, stop: async () => {} },
    undefined,
    undefined,
    async (path) => {
      preparations += 1;
      await rm(path, { force: true });
    },
  );

  try {
    await expect(
      recording.operations.screenRecordingStart?.({
        ...input(),
        outputPath,
        scope: 'device',
      }),
    ).rejects.toThrow('web recordings do not support --scope');
    expect(preparations).toBe(0);
    await expect(readFile(outputPath, 'utf8')).resolves.toBe('existing recording');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a non-WebM output before preparation or provider start', async () => {
  const start = vi.fn(async () => {});
  const prepare = vi.fn(async () => {});
  const recording = await runtime({ start, stop: async () => {} }, undefined, undefined, prepare);

  await expect(
    recording.operations.screenRecordingStart?.({
      ...input(),
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toThrow('web recordings require a .webm output path');
  expect(prepare).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

test('compensates a finalizer failure without stopping the browser recorder twice', async () => {
  const stop = vi.fn(async () => {});
  const recording = await runtime({ start: async () => {}, stop }, async () => {
    throw new Error('finalizer failed after browser stop');
  });
  const started = await recording.operations.screenRecordingStart?.(input());
  if (!started) throw new Error('missing recording operation');
  const handle = started.pendingHandle.transfer();

  await expect(handle.finish()).rejects.toThrow('finalizer failed after browser stop');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(stop).toHaveBeenCalledOnce();
});

function input() {
  return {
    sessionId: 'one',
    outputPath: '/tmp/capture.webm',
    scope: 'app' as const,
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    fence: { token: 'fence', generation: 1 },
  };
}

async function runtime(
  transport: NonNullable<Awaited<ReturnType<ScreenRecordingRuntimeHost['web']['resolve']>>>,
  complete: ScreenRecordingRuntimeHost['finalize']['complete'] = async () => ({}),
  signal: AbortSignal = new AbortController().signal,
  prepare: ScreenRecordingRuntimeHost['outputs']['prepare'] = async () => {},
) {
  return await bindWebScreenRecordingRuntime({
    host: {
      screenRecording: {
        web: { resolve: async () => transport },
        finalize: { complete },
        outputs: { prepare },
      },
    },
    device,
    owner: localRuntimeOwner('web'),
    signal,
  });
}
