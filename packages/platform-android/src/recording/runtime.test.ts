import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test('persists durable fence evidence and finishes through the scoped Android transport', async () => {
  let manifest = '';
  const calls: string[] = [];
  const runtime = await start({
    start: async ({ remotePath }: { remotePath: string }) => {
      calls.push(`start:${remotePath}`);
      return recordingProcess('42');
    },
    pull: async ({ remotePath, outputPath }: { remotePath: string; outputPath: string }) => {
      calls.push(`pull:${remotePath}:${outputPath}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
      calls.push(JSON.parse(contents).completion ? 'completed-evidence' : 'active-evidence');
    },
    removeManifest: async () => {
      manifest = '';
      return true;
    },
    remove: async (remotePath: string) => {
      calls.push(`remove:${remotePath}`);
      return true;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  assert.match(manifest, /"fenceToken":"fence-1"/);
  assert.match(manifest, /"fenceGeneration":2/);
  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
  });
  expect(calls.filter((call) => call.startsWith('pull:'))).toHaveLength(1);
  expect(JSON.parse(manifest)).toMatchObject({ completion: { outPath: '/tmp/capture.mp4' } });
  expect(calls.indexOf('completed-evidence')).toBeLessThan(
    calls.findIndex((call) => call.startsWith('remove:')),
  );
});

test('does not remove native evidence when bounded playable pulls are exhausted', async () => {
  vi.useFakeTimers();
  try {
    let manifest = '';
    const removed: string[] = [];
    const runtime = await start({
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      pullPlayable: async () => ({ stdout: '', stderr: '', exitCode: 0, playable: false }),
      remove: async (remotePath: string) => {
        removed.push(remotePath);
        return true;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    const finishing = handle.finish();
    const rejected = expect(finishing).rejects.toThrow('playable Android recording');
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(removed).toEqual([]);
    expect(JSON.parse(manifest)).not.toHaveProperty('completion');
  } finally {
    vi.useRealTimers();
  }
});

test('waits for a SIGINT-accepted recorder to exit before sizing or pulling its artifact', async () => {
  vi.useFakeTimers();
  try {
    let alive = true;
    const calls: string[] = [];
    const runtime = await start({
      stop: async () => {
        calls.push('sigint');
        return 'stopped' as const;
      },
      inspect: async () => (alive ? ('owned-alive' as const) : ('missing' as const)),
      size: async () => {
        calls.push('size');
        return 1;
      },
      pullPlayable: async () => {
        calls.push('pull');
        return { stdout: '', stderr: '', exitCode: 0, playable: true };
      },
    });
    const finishing = (await runtime.screenRecordingStart(recordingInput())).pendingHandle
      .transfer()
      .finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['sigint']);
    alive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toEqual(['sigint', 'size', 'size', 'pull']);
  } finally {
    vi.useRealTimers();
  }
});

test('retains native evidence when finalization fails, then cleans it through compensation', async () => {
  const calls: string[] = [];
  const stopped = new Set<string>();
  let manifest = '';
  const host = recordingHost({
    signal: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      stopped.add(pid);
      return true;
    },
    isRunning: async (pid: string) => !stopped.has(pid),
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (path: string) => {
      calls.push(`remove:${path}`);
      return true;
    },
    removeManifest: async (path: string) => {
      calls.push(`manifest:${path}`);
      return true;
    },
  });
  (host.screenRecording.finalize as { complete: () => Promise<never> }).complete = async () => {
    throw new Error('finalizer failed');
  };
  const runtime = await bindAndroidScreenRecordingRuntime({
    host,
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
  await expect(handle.finish()).rejects.toThrow('finalizer failed');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^signal:/),
      expect.stringMatching(/^remove:/),
      expect.stringMatching(/^manifest:/),
    ]),
  );
});

test('serializes a failed rotation so finish cannot publish completion', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const runtime = await start({
      start: async () => {
        starts += 1;
        if (starts > 1) throw new Error('rotation start failed');
        return recordingProcess('42');
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    await vi.advanceTimersByTimeAsync(170_000);
    expect(JSON.parse(manifest)).toMatchObject({ chunks: [{ remotePid: '42' }] });
    expect(JSON.parse(manifest)).not.toHaveProperty('pendingRemotePath');
    await expect(started.pendingHandle.transfer().finish()).rejects.toThrow(
      'rotation start failed',
    );
  } finally {
    vi.useRealTimers();
  }
});

test('falls back to sequential rotation when concurrent start is unavailable', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const runtime = await start({
      start: async () => {
        starts += 1;
        if (starts === 1 || starts > 4) return recordingProcess(String(41 + starts));
        throw new Error('concurrent unavailable');
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    await runtime.screenRecordingStart(recordingInput());
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(5);
    expect(JSON.parse(manifest).chunks).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test('rolls back a failed concurrent rotation commit and restores prior active evidence', async () => {
  vi.useFakeTimers();
  try {
    let writes = 0;
    let starts = 0;
    let manifest = '';
    const stopped = new Set<string>();
    const runtime = await start({
      start: async () => recordingProcess(String(42 + starts++)),
      writeManifest: async ({ contents }: { contents: string }) => {
        writes += 1;
        if (writes === 4) throw new Error('rotation manifest failed');
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      signal: async ({ pid }: { pid: string }) => {
        stopped.add(pid);
        return true;
      },
      isRunning: async (pid: string) => !stopped.has(pid),
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(JSON.parse(manifest)).toMatchObject({ chunks: [{ remotePid: '42' }] });
    expect(JSON.parse(manifest)).not.toHaveProperty('pendingRemotePath');
    await expect(handle.finish()).rejects.toThrow('rotation manifest failed');
    await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
    expect(stopped).toEqual(new Set(['42', '43']));
  } finally {
    vi.useRealTimers();
  }
});
