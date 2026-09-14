import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type {
  ScreenRecordingCompletion,
  ScreenRecordingLiveHandle,
} from '@agent-device/contracts/screen-recording-runtime';
import {
  adoptStartedDurableCapture,
  createDurableCaptureResourceStore,
  finishLiveDurableCapture,
  type DurableCaptureResourceDefinition,
  type DurableCaptureSessionStore,
} from '@agent-device/capture-kit/durable-capture';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

/**
 * ADR 0024 rule 6 on the backend that loses data today: a collect that fails must leave the
 * device-side artifact and the native manifest exactly where the next `record stop` looks.
 */
test('a failed collect preserves the Android artifact and native manifest for the next stop', async () => {
  vi.useFakeTimers();
  try {
    const directory = mkdtempForTestSync('agent-device-android-failed-finish-');
    const calls: string[] = [];
    const remoteFiles = new Set<string>();
    let pullSucceeds = false;
    let nativeManifest = '';
    const host = recordingHost({
      start: async ({ remotePath }: { remotePath: string }) => {
        remoteFiles.add(remotePath);
        return { process: { pid: '42', remotePath, startTime: '1' } };
      },
      exists: async (remotePath: string) => remoteFiles.has(remotePath),
      size: async (remotePath: string) => (remoteFiles.has(remotePath) ? 4_096 : undefined),
      pullPlayable: async ({ remotePath }: { remotePath: string }) => {
        calls.push('pull');
        return pullSucceeds && remoteFiles.has(remotePath)
          ? { stdout: '', stderr: '', exitCode: 0, playable: true }
          : { stdout: '', stderr: 'adb: failed to pull', exitCode: 1, playable: false };
      },
      remove: async (remotePath: string) => {
        calls.push(`remove:${remotePath}`);
        remoteFiles.delete(remotePath);
        return true;
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        nativeManifest = contents;
      },
      readManifest: async () =>
        nativeManifest
          ? { status: 'read' as const, contents: nativeManifest }
          : { status: 'missing' as const },
      removeManifest: async () => {
        calls.push('remove:manifest');
        nativeManifest = '';
        return true;
      },
    });
    const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
    const owner = localRuntimeOwner('android');
    const runtime = await bindAndroidScreenRecordingRuntime({
      host,
      device: androidRecordingDevice,
      owner,
      signal: new AbortController().signal,
    });
    const started = await runtime.screenRecordingStart(input);
    const nativeChunk = [...remoteFiles];
    const recording = await adoptAndroidRecording({
      sessionName: input.sessionId,
      owner,
      pendingHandle: started.pendingHandle,
      envelope: started.envelope,
    });

    const firstStop = recording.finish();
    const refused = expect(firstStop).rejects.toThrow('playable Android recording');
    await vi.advanceTimersByTimeAsync(3_000);
    await refused;

    expect(calls.filter((call) => call.startsWith('remove'))).toEqual([]);
    expect(remoteFiles).toEqual(new Set(nativeChunk));
    expect(JSON.parse(nativeManifest)).not.toHaveProperty('completion');
    expect(recording.manifestRecord()).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
    expect(recording.activeHandle()).toBeDefined();

    pullSucceeds = true;
    const secondStop = recording.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(secondStop).resolves.toMatchObject({ outPath: input.outputPath });
    expect(remoteFiles).toEqual(new Set());
    expect(JSON.parse(nativeManifest)).toMatchObject({ completion: { outPath: input.outputPath } });
    expect(recording.activeHandle()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

type AndroidRecordingSession = Readonly<{
  recording?: Readonly<{
    handle: ScreenRecordingLiveHandle;
    envelope: DurableResourceEnvelope<'screen-recording'>;
  }>;
}>;

/**
 * The daemon's recording record assembled around the real Android handle: the same definition the
 * daemon declares in `src/daemon/screen-recording-session-resource.ts`, including its policy,
 * driving the shared coordinator.
 */
async function adoptAndroidRecording(params: {
  sessionName: string;
  owner: RuntimeOwnerRef;
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  envelope: DurableResourceEnvelope<'screen-recording'>;
}) {
  const store = createDurableCaptureResourceStore({
    resourceKind: 'screen-recording',
    fileName: 'screen-recording.resource.json',
    displayName: 'screen recording',
  });
  const definition: DurableCaptureResourceDefinition<
    'screen-recording',
    ScreenRecordingLiveHandle,
    ScreenRecordingCompletion,
    AndroidRecordingSession
  > = {
    resourceKind: 'screen-recording',
    displayName: 'screen recording',
    store,
    failedFinishPolicy: 'preserve-retry-material',
    sessionSlot: {
      read: (session) => session.recording,
      replace: (session, recording) => ({ ...session, recording }),
    },
    completionMetadata: (completion) => ({ outPath: completion.outPath }),
    messages: {
      noActive: 'no active recording',
      cleanupPendingHint: 'Keep screen-recording.resource.json and retry stop.',
    },
  };
  const sessionsDir = mkdtempForTestSync('agent-device-android-failed-finish-session-');
  let session: AndroidRecordingSession = {};
  const sessionStore: DurableCaptureSessionStore<AndroidRecordingSession> = {
    set: (_name, next) => {
      session = next;
    },
    resolveSessionDir: (name) => path.join(sessionsDir, name),
  };
  const resourcePath = store.resolvePath(sessionStore.resolveSessionDir(params.sessionName));
  await adoptStartedDurableCapture(
    definition,
    {
      reportUndurableCleanup: () => {},
      session,
      sessionName: params.sessionName,
      sessionStore,
      device: androidRecordingDevice,
      owner: params.owner,
      fence: params.envelope.fence,
      pendingHandle: params.pendingHandle,
      envelope: params.envelope,
      throwIfCanceled: () => {},
    },
    resourcePath,
  );
  return {
    finish: () =>
      finishLiveDurableCapture(
        definition,
        {
          session,
          sessionName: params.sessionName,
          sessionStore,
          intent: 'capture',
        },
        resourcePath,
      ),
    manifestRecord: () => store.read(resourcePath),
    activeHandle: () => session.recording?.handle,
  };
}
