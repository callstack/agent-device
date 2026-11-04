import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingLiveHandle } from '@agent-device/contracts/screen-recording-runtime';
import { recordingFileStore } from '@agent-device/capture-kit/recording-artifact-fixtures';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  adoptStartedScreenRecording,
  finishLiveScreenRecording,
  finishRecoveredScreenRecording,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
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

test.each(['release-unavailable', 'writer-scan-inconclusive'] as const)(
  'an exported recording retains its binding and retries when %s',
  async (failure) => {
    vi.useFakeTimers();
    try {
      const directory = mkdtempForTestSync('android-release-retry-');
      const files = recordingFileStore();
      const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
      let marker = '';
      let available = false;
      const scan = vi.fn(async () => ({
        writers: [],
        conclusive: available || failure !== 'writer-scan-inconclusive',
      }));
      const finalize = vi.fn(async () => ({}));
      const host = recordingHost({
        files,
        outputs: {
          copy: async ({ from, to }: { from: string; to: string }) => {
            await files.outputs.copy({ from, to });
            if (to === input.outputPath) writeFileSync(to, files.files.get(to)!);
          },
        },
        findRunning: scan,
        writeManifest: async ({ contents }: { contents: string }) => {
          marker = contents;
        },
        readManifest: async () =>
          marker ? { status: 'read' as const, contents: marker } : { status: 'missing' as const },
        finalize: { complete: finalize },
      });
      const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
      const releaseOriginal = transport.releaseAdmission.bind(transport);
      const release = vi
        .spyOn(transport, 'releaseAdmission')
        .mockImplementation(async (input) =>
          !available && failure === 'release-unavailable'
            ? 'unavailable'
            : await releaseOriginal(input),
        );
      const owner = localRuntimeOwner('android');
      const runtime = await bindAndroidScreenRecordingRuntime({
        host,
        device: androidRecordingDevice,
        owner,
        signal: new AbortController().signal,
      });
      const started = await runtime.screenRecordingStart(input);
      const recording = await adoptAndroidRecording({
        sessionName: input.sessionId,
        owner,
        pendingHandle: started.pendingHandle,
        envelope: started.envelope,
      });
      const first = recording.finish();
      const completed = expect(first).resolves.toMatchObject({
        outPath: input.outputPath,
        nativePathDisposition: 'pending',
      });
      await Promise.all([vi.advanceTimersByTimeAsync(1_000), completed]);
      const completedMarker = JSON.parse(marker);
      expect(completedMarker).toMatchObject({ completion: { outPath: input.outputPath } });
      expect(completedMarker.admissionReleased).toBeUndefined();
      expect(files.files.get(input.outputPath)).toBe('pulled');
      expect(readFileSync(input.outputPath, 'utf8')).toBe('pulled');
      expect(scan).toHaveBeenCalledWith(completedMarker.chunks[0].remotePath);
      if (failure === 'release-unavailable') expect(release).toHaveBeenCalled();
      else expect(release).not.toHaveBeenCalled();
      expect(recording.manifestRecord()).toMatchObject({
        status: 'decoded',
        envelope: {
          lifecycle: 'open',
          metadata: {
            phase: 'cleanup-pending',
            cleanupStatus: 'cleanup-pending',
            deviceClaimToken: input.claimToken,
            completion: { outPath: input.outputPath },
          },
        },
      });
      expect(recording.activeHandle()).toBeDefined();
      await expect(
        runtime.screenRecordingReattach({ envelope: started.envelope }),
      ).resolves.toMatchObject({
        status: 'completed',
        result: { outPath: input.outputPath, nativePathDisposition: 'pending' },
        cleanupPending: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
      });
      await expect(
        finishRecoveredScreenRecording({
          resourcePath: recording.resourcePath,
          scope: {
            signal: new AbortController().signal,
            diagnostics: { emit: () => {} },
            progress: { report: () => {} },
          },
          acquireControl: async () => ({
            reattach: async (envelope) => await runtime.screenRecordingReattach({ envelope }),
            cleanup: async (envelope) => await runtime.screenRecordingCleanup({ envelope }),
            [Symbol.asyncDispose]: async () => {},
          }),
        }),
      ).resolves.toMatchObject({ outPath: input.outputPath, nativePathDisposition: 'pending' });
      await expect(
        finishRecoveredScreenRecording({
          resourcePath: recording.resourcePath,
          scope: {
            signal: new AbortController().signal,
            diagnostics: { emit: () => {} },
            progress: { report: () => {} },
          },
          acquireControl: async () => {
            throw new Error('owner unavailable');
          },
        }),
      ).resolves.toMatchObject({ outPath: input.outputPath, nativePathDisposition: 'pending' });
      await expect(recording.finishDisposal()).rejects.toMatchObject({
        details: { reason: 'cleanup-unconfirmed' },
      });
      await expect(recording.dispose()).rejects.toMatchObject({
        details: { reason: 'cleanup-unconfirmed' },
      });
      expect(recording.activeHandle()).toBeDefined();
      expect(recording.manifestRecord()).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open', metadata: { phase: 'cleanup-pending' } },
      });
      expect(JSON.parse(marker)).toEqual(completedMarker);
      expect(files.files.get(input.outputPath)).toBe('pulled');
      expect(readFileSync(input.outputPath, 'utf8')).toBe('pulled');

      available = true;
      if (failure === 'release-unavailable')
        await expect(recording.finish()).resolves.toMatchObject({ outPath: input.outputPath });
      else await expect(recording.dispose()).resolves.toBeUndefined();
      expect(finalize).toHaveBeenCalledOnce();
      expect(JSON.parse(marker)).toMatchObject({ admissionReleased: true });
      expect(files.files.get(input.outputPath)).toBe('pulled');
      expect(recording.activeHandle()).toBeUndefined();
      expect(recording.manifestRecord()).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'completed' },
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(['confirmed', 'receipt-unavailable'] as const)(
  'a successor cannot turn %s admission release into a false completion',
  async (receipt) => {
    vi.useFakeTimers();
    try {
      const directory = mkdtempForTestSync('android-release-successor-');
      const files = recordingFileStore();
      let marker = '';
      let markerPath = '';
      const host = recordingHost({
        files,
        writeManifest: async (input: { manifestPath: string; contents: string }) => {
          markerPath = input.manifestPath;
          marker = input.contents;
        },
        readManifest: async (path: string) =>
          path === markerPath && marker
            ? { status: 'read' as const, contents: marker }
            : { status: 'missing' as const },
      });
      const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
      const compareOriginal = transport.compareAndSetManifest.bind(transport);
      const checkpoint = vi
        .spyOn(transport, 'compareAndSetManifest')
        .mockImplementation(async (input, signal) =>
          receipt === 'receipt-unavailable' &&
          input.contents !== null &&
          JSON.parse(input.contents).admissionReleased === true
            ? 'unavailable'
            : await compareOriginal(input, signal),
        );
      const release = vi.spyOn(transport, 'releaseAdmission');
      const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
      const runtime = await bindAndroidScreenRecordingRuntime({
        host,
        device: androidRecordingDevice,
        owner: localRuntimeOwner('android'),
        signal: new AbortController().signal,
      });
      const started = await runtime.screenRecordingStart(input);
      const handle = started.pendingHandle.transfer();
      const finish = handle.finish();
      const first = expect(finish).resolves.toMatchObject({
        status: 'completed',
        ...(receipt === 'confirmed'
          ? {}
          : { cleanupPending: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' } }),
      });
      await Promise.all([vi.advanceTimersByTimeAsync(1_000), first]);
      expect(files.files.get(input.outputPath)).toBe('pulled');
      expect(release).toHaveBeenCalledOnce();
      const successor = 'b'.repeat(64);
      expect(await transport.acquireAdmission(successor)).toBe('acquired');
      checkpoint.mockRestore();

      const replay = await runtime.screenRecordingReattach({ envelope: started.envelope });
      if (receipt === 'confirmed') {
        expect(JSON.parse(marker)).toMatchObject({ admissionReleased: true });
        expect(replay).toMatchObject({
          status: 'completed',
          result: { outPath: input.outputPath },
        });
        expect(replay).not.toHaveProperty('cleanupPending');
        expect(release).toHaveBeenCalledOnce();
        expect(await transport.acquireAdmission('a'.repeat(64))).toBe('busy');
      } else {
        expect(JSON.parse(marker).admissionReleased).toBeUndefined();
        expect(replay).toMatchObject({
          status: 'completed',
          result: { outPath: input.outputPath, nativePathDisposition: 'pending' },
          cleanupPending: { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' },
        });
        expect(release).toHaveReturnedTimes(2);
        expect(await transport.acquireAdmission('a'.repeat(64))).toBe('busy');
        expect(
          await transport.releaseAdmission({
            owner: successor,
            manifestPath: '/sdcard/successor.json',
            expected: null,
          }),
        ).toBe('released');
        await expect(
          runtime.screenRecordingReattach({ envelope: started.envelope }),
        ).resolves.toMatchObject({
          status: 'completed',
          result: { outPath: input.outputPath },
        });
        expect(JSON.parse(marker)).toMatchObject({ admissionReleased: true });
      }
      expect(files.files.get(input.outputPath)).toBe('pulled');
    } finally {
      vi.useRealTimers();
    }
  },
);

type AndroidRecordingSession = Readonly<{
  recording?: Readonly<{
    handle: ScreenRecordingLiveHandle;
    envelope: DurableResourceEnvelope<'screen-recording'>;
  }>;
}>;

/**
 * The daemon's recording record assembled around the real Android handle: the same definition the
 * daemon declares in `packages/capture-kit/src/capture-admission/screen-recording-session-resource.ts`, including its policy,
 * driving the shared coordinator.
 */
async function adoptAndroidRecording(params: {
  sessionName: string;
  owner: RuntimeOwnerRef;
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  envelope: DurableResourceEnvelope<'screen-recording'>;
}) {
  const store = screenRecordingResourceStore;
  const sessionsDir = mkdtempForTestSync('agent-device-android-failed-finish-session-');
  let session: AndroidRecordingSession = {};
  const sessionStore = {
    resolveSessionDir: (name: string) => path.join(sessionsDir, name),
  };
  const binding = {
    address: params.sessionName,
    sessionDir: sessionStore.resolveSessionDir(params.sessionName),
    read: () => session.recording,
    assertAdoptable: () => {
      if (session.recording) throw new Error('Already recording');
    },
    canPersist: () => !session.recording,
    adopt: (recording: AndroidRecordingSession['recording']) => {
      session = { ...session, recording };
    },
    clear: (expected: NonNullable<AndroidRecordingSession['recording']>) => {
      if (session.recording?.handle !== expected.handle) return 'resource-changed' as const;
      session = { ...session, recording: undefined };
      return 'cleared' as const;
    },
  };
  const resourcePath = store.resolvePath(binding.sessionDir);
  await adoptStartedScreenRecording({
    admissionLedger: createScreenRecordingAdmissionLedger(),
    binding,
    device: androidRecordingDevice,
    owner: params.owner,
    fence: params.envelope.fence,
    pendingHandle: params.pendingHandle,
    envelope: params.envelope,
    throwIfCanceled: () => {},
  });
  return {
    finish: () => finishLiveScreenRecording({ binding, intent: 'capture' }),
    finishDisposal: () => finishLiveScreenRecording({ binding, intent: 'disposal' }),
    manifestRecord: () => store.read(resourcePath),
    activeHandle: () => session.recording?.handle,
    dispose: () => screenRecordingDurableResource.forceCleanupLive({ binding }),
    resourcePath,
  };
}
