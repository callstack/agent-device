import { expect, test } from 'vitest';
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

test('reattaches complete matching evidence and refuses fence, session, or device changes', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
  });
  const started = await runtime.screenRecordingStart({
    ...recordingInput(),
    outputPath: '/tmp/manifest-name.mp4',
    clientOutputPath: '/client/manifest-name.mp4',
    scope: 'system',
    recordOnlySession: true,
    activeSessionApp: { bundleId: 'com.example.app', name: 'Example' },
    exportQuality: 'high',
  });
  const active = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(active.status).toBe('active');
  if (active.status === 'active')
    expect(active.handle.inspect()).toMatchObject({
      outPath: '/tmp/manifest-name.mp4',
      clientOutPath: '/client/manifest-name.mp4',
      scope: 'system',
      recordOnlySession: true,
      exportQuality: 'high',
    });
  for (const envelope of [
    { ...started.envelope, fence: { token: 'other', generation: 2 } },
    { ...started.envelope, sessionId: 'other-session' },
    { ...started.envelope, device: { ...started.envelope.device, id: 'other-device' } },
  ]) {
    await expect(runtime.screenRecordingReattach({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
    });
  }
});

test('reattaches an ended pid with an artifact as finishable recovery and reports the 180s warning', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    isRunning: async () => false,
    exists: async () => true,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const reattached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(reattached.status).toBe('active');
  if (reattached.status === 'active')
    await expect(reattached.handle.finish()).resolves.toMatchObject({
      status: 'completed',
      result: { warning: expect.stringContaining('likely after reaching the 180s platform limit') },
    });
});

test('returns fenced native completion after a crash between native finalization and daemon terminalization', async () => {
  let manifest = '';
  const removals: string[] = [];
  let gcWouldFail = false;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removals.push(remotePath);
      return !gcWouldFail;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const result = await started.pendingHandle.transfer().finish();
  expect(result.status).toBe('completed');
  expect(JSON.parse(manifest)).toMatchObject({ completion: { outPath: '/tmp/capture.mp4' } });
  gcWouldFail = true;
  if (result.status === 'completed') {
    await expect(runtime.screenRecordingReattach({ envelope: started.envelope })).resolves.toEqual({
      status: 'completed',
      result: result.result,
    });
  }
  expect(removals).toHaveLength(1);
});

test('retains completed evidence while an exact persisted recorder identity remains alive', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    inspect: async () => 'owned-alive' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const native = JSON.parse(manifest);
  manifest = JSON.stringify({
    ...native,
    completion: {
      backend: 'adb screenrecord',
      outPath: native.outputPath,
      startedAt: native.startedAt,
      completedAt: native.startedAt + 1,
      scope: native.scope,
      showTouches: native.showTouches,
      recordOnlySession: native.recordOnlySession,
    },
  });

  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'ownership-fence-lost',
  });
  expect(JSON.parse(manifest)).toHaveProperty('completion');
});

test('makes matching pending evidence cleanup-eligible and stops discovered exact recorder pids', async () => {
  let manifest = '';
  const removed: string[] = [];
  const signals: string[] = [];
  const stopped = new Set<string>();
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removed.push(remotePath);
      return true;
    },
    findRunning: async () => ['66'],
    stop: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      stopped.add(pid);
      return 'stopped' as const;
    },
    inspect: async () => 'missing' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  manifest = JSON.stringify({
    ...JSON.parse(manifest),
    chunks: [],
    pendingRemotePath: '/data/local/tmp/agent-device-recording-777.mp4',
  });
  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
    message: 'Android recording launch was interrupted before its process identity was committed.',
  });
  await expect(runtime.screenRecordingCleanup({ envelope: started.envelope })).resolves.toEqual({
    status: 'cleaned',
  });
  expect(removed).toEqual(['/data/local/tmp/agent-device-recording-777.mp4']);
  expect(signals).toEqual(['66']);
});
