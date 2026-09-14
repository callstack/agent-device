import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test('rejects corrupt native chunk paths with zero side effects', async () => {
  let manifest = '';
  const calls: string[] = [];
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    signal: async () => {
      calls.push('signal');
      return true;
    },
    pull: async () => {
      calls.push('pull');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    remove: async () => {
      calls.push('remove');
      return true;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  manifest = JSON.stringify({
    ...JSON.parse(manifest),
    chunks: [{ index: 1, remotePid: '42', remotePath: '/data/local/tmp/unrelated.mp4' }],
  });
  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'unreattachable', reason: 'ownership-fence-lost' });
  await expect(
    runtime.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending', reason: 'ownership-fence-lost' });
  expect(calls).toEqual([]);
});

test('retains evidence when artifact or manifest deletion is unconfirmed', async () => {
  let artifactManifest = '';
  const artifactRuntime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      artifactManifest = contents;
    },
    remove: async () => false,
  });
  const artifact = await artifactRuntime.screenRecordingStart(recordingInput());
  await expect(artifact.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
    status: 'cleanup-pending',
  });
  expect(artifactManifest).not.toBe('');
  let manifest = '';
  const manifestRuntime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    removeManifest: async () => false,
  });
  const started = await manifestRuntime.screenRecordingStart(recordingInput());
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
    status: 'cleanup-pending',
  });
  expect(manifest).not.toBe('');
});

test('never signals an exact-identity mismatch', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    stop: async () => 'ownership-lost' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
    status: 'cleanup-pending',
  });
  expect(manifest).not.toBe('');
});

test('cleans verified dead evidence so a later start is admitted', async () => {
  let manifest = '';
  let starts = 0;
  let dead = false;
  const runtime = await start({
    start: async () => {
      dead = false;
      return {
        remotePid: String(40 + ++starts),
        wait: new Promise<never>(() => {}),
        terminate: async () => {},
        [Symbol.asyncDispose]: async () => {},
      };
    },
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    removeManifest: async () => {
      manifest = '';
      return true;
    },
    isRunning: async () => !dead,
    exists: async () => !dead,
  });
  const first = await runtime.screenRecordingStart(recordingInput());
  dead = true;
  await expect(
    runtime.screenRecordingReattach({ envelope: first.envelope }),
  ).resolves.toMatchObject({ status: 'unreattachable', reason: 'transport-not-reattachable' });
  await expect(runtime.screenRecordingCleanup({ envelope: first.envelope })).resolves.toEqual({
    status: 'cleaned',
  });
  await expect(runtime.screenRecordingStart(recordingInput())).resolves.toMatchObject({
    envelope: expect.any(Object),
  });
  expect(starts).toBe(2);
});

const inconclusiveWriterScans = [
  ['no recorder at all', { writers: [], conclusive: false }],
  [
    'one recorder and an unreadable candidate',
    {
      writers: [{ pid: '88', remotePath: '/sdcard/agent-device-recording-9.mp4', startTime: '4' }],
      conclusive: false,
    },
  ],
];

test.each(inconclusiveWriterScans)(
  'retains evidence when the pending artifact writer scan reports %s',
  async (_name, scan) => {
    const pendingPath = '/sdcard/agent-device-recording-9.mp4';
    let manifest = '';
    const removed: string[] = [];
    const signalled: string[] = [];
    const runtime = await start({
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      removeManifest: async () => {
        manifest = '';
        return true;
      },
      remove: async (path: string) => {
        removed.push(path);
        return true;
      },
      signal: async ({ pid }: { pid: string }) => {
        signalled.push(pid);
        return true;
      },
      findRunning: async () => scan,
      isRunning: async () => false,
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    manifest = JSON.stringify({ ...JSON.parse(manifest), pendingRemotePath: pendingPath });
    await expect(
      runtime.screenRecordingCleanup({ envelope: started.envelope }),
    ).resolves.toMatchObject({ status: 'cleanup-pending' });
    expect(signalled).toEqual([]);
    expect(removed).toEqual([]);
    expect(manifest).not.toBe('');
  },
);

test('retains evidence when the recorder presence probe is uncertain', async () => {
  vi.useFakeTimers();
  try {
    let manifest = '';
    const runtime = await start({
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      inspect: async () => 'uncertain' as const,
      stop: async () => 'uncertain' as const,
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const cleanup = runtime.screenRecordingCleanup({ envelope: started.envelope });

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cleanup).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'transport-failed',
    });
    expect(manifest).not.toBe('');
    await expect(runtime.screenRecordingStart(recordingInput())).rejects.toMatchObject({
      code: 'DEVICE_IN_USE',
      details: { reason: 'native_recovery_evidence_open' },
    });
  } finally {
    vi.useRealTimers();
  }
});

test('rejects a tampered output path before native recovery side effects', async () => {
  let manifest = '';
  const calls: string[] = [];
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    signal: async () => {
      calls.push('signal');
      return true;
    },
    remove: async () => {
      calls.push('remove');
      return true;
    },
    pull: async () => {
      calls.push('pull');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  manifest = JSON.stringify({ ...JSON.parse(manifest), outputPath: '/tmp/unrelated.mp4' });
  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'unreattachable', reason: 'ownership-fence-lost' });
  await expect(
    runtime.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending', reason: 'ownership-fence-lost' });
  expect(calls).toEqual([]);
});

test('refuses mode-mismatched recovery without using a replacement transport', async () => {
  let manifest = '';
  const calls: string[] = [];
  const local = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
  });
  const started = await local.screenRecordingStart(recordingInput());
  const composed = await bindAndroidScreenRecordingRuntime({
    host: recordingHost({
      mode: 'transport-composed',
      readManifest: async () => ({ status: 'read' as const, contents: manifest }),
      signal: async () => {
        calls.push('signal');
        return true;
      },
      pull: async () => {
        calls.push('pull');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  await expect(
    composed.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'unreattachable', reason: 'transport-not-reattachable' });
  await expect(
    composed.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({ status: 'cleanup-pending', reason: 'owner-unavailable' });
  expect(calls).toEqual([]);
});
