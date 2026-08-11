import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { cleanupChunks, pullChunks, startChunkAt, stopChunk, stopOwnedChunks } from './chunks.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test('waits for equal nonzero remote sizes after exit before pulling', async () => {
  const sizes = [1, 2, 2];
  let pulls = 0;
  const runtime = await start({
    size: async () => sizes.shift() ?? 2,
    pull: async () => {
      pulls += 1;
      expect(sizes).toEqual([]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
  });
  expect(pulls).toBe(1);
});

test('returns secondary client paths, split/180s warnings, and skips chunked touch burn-in', async () => {
  vi.useFakeTimers();
  try {
    let pid = 41;
    const runtime = await start({ start: async () => recordingProcess(String(++pid)) });
    const started = await runtime.screenRecordingStart({
      ...recordingInput(),
      clientOutputPath: '/client/capture.mp4',
    });
    const handle = started.pendingHandle.transfer();
    handle.appendGestureEvents([{ kind: 'tap', tMs: 1, x: 2, y: 3 }]);
    await vi.advanceTimersByTimeAsync(170_000);
    const finishing = handle.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(finishing).resolves.toMatchObject({
      status: 'completed',
      result: {
        warning: expect.stringContaining('Android adb screenrecord is capped at 180s'),
        overlayWarning:
          'touch overlay burn-in is skipped for chunked Android recordings; returning raw chunks plus gesture telemetry',
        chunks: [
          { index: 1, clientOutPath: '/client/capture.mp4' },
          { index: 2, clientOutPath: '/client/capture.part-002.mp4' },
        ],
      },
    });
  } finally {
    vi.useRealTimers();
  }
});

test('continues through every owned chunk after a stop or removal failure', async () => {
  const chunks = [
    {
      index: 1,
      remotePath: '/sdcard/agent-device-recording-1.mp4',
      remotePid: '41',
      remoteStartTime: '1',
    },
    {
      index: 2,
      remotePath: '/sdcard/agent-device-recording-2.mp4',
      remotePid: '42',
      remoteStartTime: '1',
    },
  ] as const;
  const stopped: string[] = [];
  const removed: string[] = [];
  const transport = {
    stop: async ({ pid }: { pid: string }) => {
      stopped.push(pid);
      if (pid === '42') throw new Error('stop failed');
      return 'stopped' as const;
    },
    remove: async (path: string) => {
      removed.push(path);
      return !path.endsWith('2.mp4');
    },
  } as never;
  await expect(stopOwnedChunks(transport, chunks)).rejects.toThrow('stop failed');
  await expect(cleanupChunks(transport, chunks)).rejects.toThrow('failed to remove');
  expect(stopped).toEqual(['42', '41']);
  expect(removed).toEqual(chunks.map((chunk) => chunk.remotePath));
});

test('does not force-signal a pid after its path ownership changes during graceful stop', async () => {
  const stops: Array<{ pid: string; force?: boolean }> = [];
  const transport = {
    stop: async (input: { pid: string; force?: boolean }) => {
      stops.push(input);
      return 'ownership-lost' as const;
    },
  } as never;
  await expect(
    stopChunk(transport, {
      index: 1,
      remotePath: '/sdcard/agent-device-recording-2.mp4',
      remotePid: '42',
      remoteStartTime: '1',
    }),
  ).rejects.toThrow('ownership could not be confirmed');
  expect(stops).toEqual([
    { pid: '42', remotePath: '/sdcard/agent-device-recording-2.mp4', startTime: '1' },
  ]);
});

test('rejects an invalid start identity without attempting a numeric PID stop', async () => {
  const controller = new AbortController();
  const stops: string[] = [];
  const transport = {
    start: async () => recordingProcess('invalid'),
    stop: async ({ pid }: { pid: string }) => {
      stops.push(pid);
      return 'stopped' as const;
    },
    remove: async () => true,
  } as never;
  await expect(
    startChunkAt(
      transport,
      '/sdcard/agent-device-recording-2.mp4',
      recordingInput(),
      controller.signal,
    ),
  ).rejects.toThrow('invalid process identity');
  expect(stops).toEqual([]);
});

test('gives exact SIGINT ownership ten seconds before considering force stop', async () => {
  vi.useFakeTimers();
  try {
    const calls: Array<{ force?: boolean }> = [];
    let polls = 0;
    const transport = {
      stop: async (_process: unknown, options?: { force?: boolean }) => {
        calls.push(options ?? {});
        return options?.force ? ('stopped' as const) : ('uncertain' as const);
      },
      inspect: async () => (++polls === 3 ? ('missing' as const) : ('owned-alive' as const)),
    } as never;
    const stopping = stopChunk(transport, {
      index: 1,
      remotePath: '/sdcard/agent-device-recording-2.mp4',
      remotePid: '42',
      remoteStartTime: '7',
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(stopping).resolves.toBe(false);
    expect(calls).toEqual([{}]);
  } finally {
    vi.useRealTimers();
  }
});

test('forces only after the full ten-second identity polling window remains alive', async () => {
  vi.useFakeTimers();
  try {
    const calls: Array<{ force?: boolean }> = [];
    const transport = {
      stop: async (_process: unknown, options?: { force?: boolean }) => {
        calls.push(options ?? {});
        return 'stopped' as const;
      },
      inspect: async () => 'owned-alive' as const,
    } as never;
    const stopping = stopChunk(transport, {
      index: 1,
      remotePath: '/sdcard/agent-device-recording-2.mp4',
      remotePid: '42',
      remoteStartTime: '7',
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toEqual([{}]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toBe(false);
    expect(calls).toEqual([{}, { force: true }]);
  } finally {
    vi.useRealTimers();
  }
});

test('retries a pulled MP4 until its moov is playable and retains remote evidence on exhaustion', async () => {
  vi.useFakeTimers();
  try {
    const chunk = [
      {
        index: 1,
        remotePath: '/sdcard/agent-device-recording-2.mp4',
        remotePid: '42',
        remoteStartTime: '7',
      },
    ] as const;
    let pulls = 0;
    const becomingPlayable = pullChunks(
      {
        pullPlayable: async () => ({
          stdout: '',
          stderr: '',
          exitCode: 0,
          playable: ++pulls === 3,
        }),
      } as never,
      chunk,
      '/tmp/capture.mp4',
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(becomingPlayable).resolves.toEqual([{ index: 1, path: '/tmp/capture.mp4' }]);
    expect(pulls).toBe(3);

    pulls = 0;
    const exhausted = pullChunks(
      {
        pullPlayable: async () => ({
          stdout: '',
          stderr: '',
          exitCode: 0,
          playable: (++pulls, false),
        }),
      } as never,
      chunk,
      '/tmp/capture.mp4',
    );
    const rejected = expect(exhausted).rejects.toThrow('playable Android recording');
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(pulls).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
