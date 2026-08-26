import { expect, test } from 'vitest';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>, signal = new AbortController().signal) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal,
  });

test('publishes fenced pending evidence before launching the first child', async () => {
  const order: string[] = [];
  let pending: Record<string, unknown> | undefined;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      const parsed = JSON.parse(contents) as Record<string, unknown>;
      order.push(`manifest:${Array.isArray(parsed.chunks) ? parsed.chunks.length : -1}`);
      if (Array.isArray(parsed.chunks) && parsed.chunks.length === 0) pending = parsed;
    },
    start: async () => {
      order.push('start');
      return recordingProcess('42');
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  expect(order.slice(0, 2)).toEqual(['manifest:0', 'start']);
  expect(pending).toMatchObject({
    fenceToken: 'fence-1',
    sessionId: 'one',
    deviceId: 'emulator-5554',
  });
  await started.pendingHandle.transfer().forceCleanup();
});

test('retained native evidence blocks replacement before output preparation or launch', async () => {
  let starts = 0;
  let writes = 0;
  let prepared = 0;
  const runtime = await bindAndroidScreenRecordingRuntime({
    host: recordingHost({
      start: async () => {
        starts += 1;
        return recordingProcess('42');
      },
      writeManifest: async () => {
        writes += 1;
      },
      readManifest: async () => ({ status: 'read' as const, contents: '{broken' }),
      outputs: {
        prepare: async () => {
          prepared += 1;
        },
      },
    }),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toThrow(
    'native recovery evidence already exists',
  );
  expect({ starts, writes, prepared }).toEqual({ starts: 0, writes: 0, prepared: 0 });
});

test('unavailable native evidence blocks replacement before output preparation or launch', async () => {
  let starts = 0;
  let writes = 0;
  let prepared = 0;
  const runtime = await bindAndroidScreenRecordingRuntime({
    host: recordingHost({
      start: async () => {
        starts += 1;
        return recordingProcess('42');
      },
      writeManifest: async () => {
        writes += 1;
      },
      readManifest: async () => ({
        status: 'unavailable' as const,
        message: 'adb transport did not confirm the native manifest state',
      }),
      outputs: {
        prepare: async () => {
          prepared += 1;
        },
      },
    }),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toThrow(
    'native recovery evidence is unavailable',
  );
  expect({ starts, writes, prepared }).toEqual({ starts: 0, writes: 0, prepared: 0 });
});

test('cleans a failed candidate before authorizing fallback and aborts if that cleanup is uncertain', async () => {
  const live = new Set<string>();
  let starts = 0;
  const order: string[] = [];
  const runtime = await start({
    start: async ({ remotePath }: Parameters<AndroidScreenRecordingTransport['start']>[0]) => {
      starts += 1;
      order.push(`start:${remotePath}`);
      if (starts === 1) throw new Error('sdcard unavailable');
      return recordingProcess('42');
    },
    writeManifest: async ({ manifestPath }: { manifestPath: string }) => {
      live.add(manifestPath);
      order.push(`write:${manifestPath}`);
    },
    removeManifest: async (manifestPath: string) => {
      order.push(`remove:${manifestPath}`);
      return live.delete(manifestPath);
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  expect(order.slice(0, 3)).toEqual([
    expect.stringContaining('write:/sdcard/'),
    expect.stringContaining('start:/sdcard/'),
    expect.stringContaining('remove:/sdcard/'),
  ]);
  expect(live).toEqual(new Set(['/data/local/tmp/agent-device-recording-active.json']));
  await started.pendingHandle.transfer().forceCleanup();

  const noFallback = await start({
    start: async () => {
      starts += 1;
      throw new Error('unavailable');
    },
    removeManifest: async () => {
      throw new Error('unavailable');
    },
  });
  await expect(noFallback.screenRecordingStart(recordingInput())).rejects.toThrow(
    'Android screenrecord launch rollback could not be confirmed',
  );
  expect(starts).toBe(3);
});

test('rejects an invalid process identity before committing active evidence', async () => {
  const runtime = await start({
    start: async () => recordingProcess('not-a-pid'),
    removeManifest: async () => {
      throw new Error('unavailable');
    },
  });
  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toThrow(
    'launch rollback could not be confirmed',
  );
});

test('rolls back a child when initial active evidence publication fails', async () => {
  const calls: string[] = [];
  let writes = 0;
  const runtime = await start({
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      return 'already-missing' as const;
    },
    remove: async (remotePath: string) => {
      calls.push(`remove:${remotePath}`);
      return true;
    },
    writeManifest: async () => {
      writes += 1;
      if (writes === 2) throw new Error('manifest publication failed');
    },
  });
  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toThrow(
    'manifest publication failed',
  );
  expect(calls).toEqual([
    'signal:42',
    expect.stringMatching(/^remove:\/sdcard\/agent-device-recording-\d+\.mp4$/),
  ]);
});

test('preserves cancellation before and after child acquisition without retries', async () => {
  const before = new AbortController();
  const reason = new Error('setup canceled');
  before.abort(reason);
  const never = await start({ start: async () => recordingProcess('42') }, before.signal);
  await expect(never.screenRecordingStart(recordingInput())).rejects.toBe(reason);

  const after = new AbortController();
  const calls: string[] = [];
  let disposals = 0;
  const runtime = await start(
    {
      start: async () => {
        calls.push('start');
        after.abort(reason);
        return {
          ...recordingProcess('42'),
          [Symbol.asyncDispose]: async () => {
            disposals += 1;
          },
        };
      },
      stop: async ({ pid, force }: { pid: string; force?: boolean }) => {
        calls.push(`signal:${pid}:${String(force)}`);
        return 'already-missing' as const;
      },
      remove: async () => {
        calls.push('remove');
        return true;
      },
    },
    after.signal,
  );
  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBe(reason);
  expect(calls).toEqual(['start', 'signal:42:undefined', 'remove']);
  expect(disposals).toBe(0);
});

test('cancellation after child acquisition retires pending native evidence after rollback', async () => {
  const controller = new AbortController();
  const reason = new Error('recording canceled after native acquisition');
  const calls: string[] = [];
  let manifest = '';
  const runtime = await start(
    {
      start: async () => {
        calls.push('start');
        controller.abort(reason);
        return recordingProcess('42');
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      removeManifest: async () => {
        calls.push('remove-manifest');
        manifest = '';
        return true;
      },
      stop: async ({ pid }: { pid: string }) => {
        calls.push(`signal:${pid}`);
        return 'already-missing' as const;
      },
      remove: async () => {
        calls.push('remove-artifact');
        return true;
      },
    },
    controller.signal,
  );

  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBe(reason);
  expect(calls).toEqual(['start', 'signal:42', 'remove-artifact', 'remove-manifest']);
  expect(manifest).toBe('');
});

test('cancellation retains pending native evidence when rollback is unconfirmed', async () => {
  const controller = new AbortController();
  const reason = new Error('recording canceled with uncertain native cleanup');
  const calls: string[] = [];
  let manifest = '';
  const runtime = await start(
    {
      start: async () => {
        calls.push('start');
        controller.abort(reason);
        return recordingProcess('42');
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      removeManifest: async () => {
        calls.push('remove-manifest');
        manifest = '';
        return true;
      },
      stop: async ({ pid }: { pid: string }) => {
        calls.push(`signal:${pid}`);
        return 'ownership-lost' as const;
      },
    },
    controller.signal,
  );

  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBe(reason);
  expect(calls).toEqual(['start', 'signal:42']);
  expect(manifest).not.toBe('');
});
