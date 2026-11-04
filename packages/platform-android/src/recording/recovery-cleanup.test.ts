import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';
import { AndroidScreenRecordingStartRollbackUnconfirmed } from './chunks.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test.each([
  'empty',
  'inconclusive',
  'foreign-writer',
  'released-with-successor',
  'released-with-successor-and-writer',
] as const)('direct cleanup checks a reused PID and path writers when %s', async (caseName) => {
  const markers = new Map<string, string>();
  const markerWrites: { manifestPath: string; contents: string }[] = [];
  const files = recordingFileStore();
  const stop = vi.fn(async () => 'ownership-lost' as const);
  const signals: string[] = [];
  let writerAfterReceipt = false;
  const scan = vi.fn(async (remotePath: string) => ({
    writers:
      caseName === 'foreign-writer' || writerAfterReceipt
        ? [{ pid: '42', remotePath, startTime: '99' }]
        : [],
    conclusive: caseName !== 'inconclusive',
  }));
  const remove = vi.fn(async () => true);
  const host = recordingHost({
    files,
    writeManifest: async ({
      manifestPath,
      contents,
    }: {
      manifestPath: string;
      contents: string;
    }) => {
      markers.set(manifestPath, contents);
      markerWrites.push({ manifestPath, contents });
    },
    readManifest: async (manifestPath: string) =>
      markers.has(manifestPath)
        ? { status: 'read' as const, contents: markers.get(manifestPath)! }
        : { status: 'missing' as const },
    removeManifest: async (manifestPath: string) => {
      markers.delete(manifestPath);
      return true;
    },
    inspect: async () => 'ownership-lost' as const,
    stop,
    signal: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      return true;
    },
    findRunning: scan,
    remove,
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const release = vi.spyOn(transport, 'releaseAdmission');
  const runtime = await bindAndroidScreenRecordingRuntime({
    host,
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  const input = recordingInput();
  const started = await runtime.screenRecordingStart(input);
  const markerPath = started.envelope.descriptor.body.manifestPath;
  if (typeof markerPath !== 'string') throw new Error('Expected generation marker');
  const active = JSON.parse(markers.get(markerPath)!);
  const completed = JSON.stringify({
    ...active,
    completion: {
      backend: 'adb screenrecord',
      outPath: input.outputPath,
      startedAt: active.startedAt,
      completedAt: active.startedAt + 1,
      scope: input.scope,
      showTouches: input.showTouches,
      recordOnlySession: input.recordOnlySession,
    },
  });
  markers.set(markerPath, completed);
  files.files.set(input.outputPath, 'export');
  expect(started.envelope).toMatchObject({
    fence: input.fence,
    metadata: { deviceClaimToken: input.claimToken },
  });
  for (const envelope of [
    { ...started.envelope, fence: { ...input.fence, generation: input.fence.generation + 1 } },
    {
      ...started.envelope,
      metadata: { ...started.envelope.metadata, deviceClaimToken: 'replacement-claim' },
    },
  ]) {
    await expect(runtime.screenRecordingCleanup({ envelope })).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'ownership-fence-lost',
    });
  }
  expect(stop).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(markers.get(markerPath)).toBe(completed);
  if (caseName === 'released-with-successor' || caseName === 'released-with-successor-and-writer') {
    await expect(
      runtime.screenRecordingReattach({ envelope: started.envelope }),
    ).resolves.toMatchObject({
      status: 'completed',
    });
    expect(JSON.parse(markers.get(markerPath)!)).toMatchObject({ admissionReleased: true });
    expect(await transport.acquireAdmission('b'.repeat(64))).toBe('acquired');
    const successorPath = `/sdcard/agent-device-recording-v2-admitted-${'b'.repeat(64)}.json`;
    expect(
      await transport.compareAndSetManifest({
        manifestPath: successorPath,
        expected: null,
        contents: 'successor bytes',
      }),
    ).toBe('updated');
    release.mockClear();
    scan.mockClear();
    writerAfterReceipt = caseName === 'released-with-successor-and-writer';
  }
  const before = markers.get(markerPath);
  const result = await runtime.screenRecordingCleanup({ envelope: started.envelope });
  expect(stop).toHaveBeenCalledOnce();
  expect(signals).toEqual([]);
  expect(scan).toHaveBeenCalledWith(active.chunks[0].remotePath);
  if (
    caseName === 'inconclusive' ||
    caseName === 'foreign-writer' ||
    caseName === 'released-with-successor-and-writer'
  ) {
    expect(result).toMatchObject({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' });
    expect(markers.get(markerPath)).toBe(before);
    expect(remove).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(await transport.acquireAdmission('c'.repeat(64))).toBe('busy');
    if (caseName === 'released-with-successor-and-writer') {
      const successorPath = `/sdcard/agent-device-recording-v2-admitted-${'b'.repeat(64)}.json`;
      expect(markers.get(successorPath)).toBe('successor bytes');
    }
  } else {
    expect(result).toEqual({ status: 'cleaned' });
    expect(markers.has(markerPath)).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith(active.chunks[0].remotePath);
    expect(
      markerWrites
        .filter((write) => write.manifestPath === markerPath)
        .some((write) => JSON.parse(write.contents).admissionReleased === true),
    ).toBe(true);
    if (caseName === 'empty') expect(release).toHaveBeenCalledOnce();
    else {
      expect(release).not.toHaveBeenCalled();
      const successorPath = `/sdcard/agent-device-recording-v2-admitted-${'b'.repeat(64)}.json`;
      expect(markers.get(successorPath)).toBe('successor bytes');
      expect(await transport.acquireAdmission('c'.repeat(64))).toBe('busy');
    }
  }
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
  ['no recorder at all', false],
  ['one recorder and an unreadable candidate', true],
] as const;

test.each(inconclusiveWriterScans)(
  'retains evidence when the pending artifact writer scan reports %s',
  async (_name, hasWriter) => {
    let manifest = '';
    let pendingPath = '';
    const removed: string[] = [];
    const signalled: string[] = [];
    const scan = vi.fn(async () => ({
      writers: hasWriter ? [{ pid: '88', remotePath: pendingPath, startTime: '4' }] : [],
      conclusive: false,
    }));
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
      findRunning: scan,
      isRunning: async () => false,
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const active = JSON.parse(manifest);
    pendingPath = active.chunks[0].remotePath.replace(/-\d+\.mp4$/, '-9.mp4');
    manifest = JSON.stringify({
      ...active,
      chunks: [],
      pendingRemotePath: pendingPath,
      launchDisposition: 'canceled',
      startNoEffectConfirmed: true,
    });
    await expect(
      runtime.screenRecordingCleanup({ envelope: started.envelope }),
    ).resolves.toMatchObject({ status: 'cleanup-pending' });
    expect(scan).toHaveBeenCalledExactlyOnceWith(pendingPath);
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
      reason: 'cleanup-unconfirmed',
    });
    expect(manifest).not.toBe('');
    await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBeInstanceOf(
      AndroidScreenRecordingStartRollbackUnconfirmed,
    );
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
