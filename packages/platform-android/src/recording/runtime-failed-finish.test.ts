import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type {
  DeviceRuntimeGateway,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
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
import { readPendingScreenRecordingCompletion } from '@agent-device/capture-kit/screen-recording-stop-recovery';
import { recoverScreenRecordingResourceAfterDaemonLock } from '@agent-device/capture-kit/screen-recording-recovery';
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
    const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
    const outputFiles = recordingFileStore();
    const calls: string[] = [];
    const remoteFiles = new Set<string>();
    let pullSucceeds = false;
    let nativeManifest = '';
    const host = recordingHost({
      files: outputFiles,
      outputs: {
        copy: async ({ from, to }: { from: string; to: string }) => {
          await outputFiles.outputs.copy({ from, to });
          if (to === input.outputPath) writeFileSync(to, outputFiles.files.get(to)!);
        },
      },
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

test('a deleted export is refused while its exact admission is retried', async () => {
  vi.useFakeTimers();
  try {
    const directory = mkdtempForTestSync('android-deleted-export-');
    const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
    const files = recordingFileStore();
    let marker = '';
    let available = false;
    const host = recordingHost({
      files,
      outputs: {
        copy: async ({ from, to }: { from: string; to: string }) => {
          await files.outputs.copy({ from, to });
          if (to === input.outputPath) writeFileSync(to, files.files.get(to)!);
        },
        inspect: async (filePath: string) =>
          filePath === input.outputPath
            ? existsSync(filePath)
              ? 'present'
              : 'missing'
            : await files.outputs.inspect(filePath),
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        marker = contents;
      },
      readManifest: async () =>
        marker ? { status: 'read' as const, contents: marker } : { status: 'missing' as const },
    });
    const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
    const originalRelease = transport.releaseAdmission.bind(transport);
    const release = vi
      .spyOn(transport, 'releaseAdmission')
      .mockImplementation(async (request) =>
        available ? await originalRelease(request) : 'unavailable',
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
    await Promise.all([
      vi.advanceTimersByTimeAsync(1_000),
      expect(first).resolves.toMatchObject({ outPath: input.outputPath }),
    ]);
    expect(readFileSync(input.outputPath, 'utf8')).toBe('pulled');
    rmSync(input.outputPath);
    const recover = () =>
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
      });

    await expect(recording.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing' },
    });
    await expect(
      runtime.screenRecordingReattach({ envelope: started.envelope }),
    ).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'resource-missing',
    });
    await expect(recording.dispose()).rejects.toMatchObject({
      details: { reason: 'cleanup-unconfirmed' },
    });
    await expect(recover()).rejects.toMatchObject({ details: { reason: 'resource-missing' } });
    expect(JSON.parse(marker).admissionReleased).toBeUndefined();
    expect(recording.activeHandle()).toBeDefined();
    expect(recording.manifestRecord()).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open', metadata: { cleanupStatus: 'cleanup-pending' } },
    });
    const attempted = release.mock.calls.length;
    expect(attempted).toBeGreaterThanOrEqual(3);

    available = true;
    await expect(recover()).rejects.toMatchObject({ details: { reason: 'resource-missing' } });
    expect(release).toHaveBeenCalledTimes(attempted + 1);
    expect(JSON.parse(marker)).toMatchObject({ admissionReleased: true });
    expect(await transport.acquireAdmission('b'.repeat(64))).toBe('acquired');
    await expect(recording.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing' },
    });
    await expect(recording.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing' },
    });
    expect(release).toHaveBeenCalledTimes(attempted + 1);
    expect(await transport.acquireAdmission('a'.repeat(64))).toBe('busy');
    expect(recording.activeHandle()).toBeDefined();
    expect(recording.manifestRecord()).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
    expect(existsSync(input.outputPath)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('a missing second chunk blocks live and cold replay while admission is retried', async () => {
  vi.useFakeTimers();
  try {
    const f = await startTwoChunkRecording({ releaseAvailable: false });
    const first = f.recording.finish();
    await Promise.all([
      vi.advanceTimersByTimeAsync(2_000),
      expect(first).resolves.toMatchObject({
        outPath: f.outputPath,
        chunks: [{ path: f.outputPath }, { path: f.secondPath }],
      }),
    ]);
    expect(readFileSync(f.outputPath, 'utf8')).toBe('pulled');
    expect(readFileSync(f.secondPath, 'utf8')).toBe('pulled');
    await expect(f.recoverUnavailable()).resolves.toMatchObject({
      outPath: f.outputPath,
      chunks: [{ path: f.outputPath }, { path: f.secondPath }],
    });
    rmSync(f.secondPath);
    await expect(f.recording.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing', outPath: f.secondPath },
    });
    await expect(
      f.runtime.screenRecordingReattach({ envelope: f.envelope }),
    ).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'resource-missing',
    });
    const pending = f.recording.manifestRecord();
    expect(pending).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open', metadata: { cleanupStatus: 'cleanup-pending' } },
    });
    if (pending.status !== 'decoded') throw new Error('Expected pending recording');
    expect(readPendingScreenRecordingCompletion(pending.envelope)).toBeUndefined();
    await expect(f.recoverUnavailable()).rejects.toThrow('owner unavailable');
    expect(JSON.parse(f.marker()).admissionReleased).toBeUndefined();
    expect(f.recording.activeHandle()).toBeDefined();

    f.setReleaseAvailable(true);
    await expect(
      f.runtime.screenRecordingReattach({ envelope: f.envelope }),
    ).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'resource-missing',
    });
    expect(JSON.parse(f.marker())).toMatchObject({ admissionReleased: true });
    expect(await f.transport.acquireAdmission('b'.repeat(64))).toBe('acquired');
    await expect(f.recording.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing', outPath: f.secondPath },
    });
    await expect(f.recoverUnavailable()).rejects.toThrow('owner unavailable');
    expect(await f.transport.acquireAdmission('c'.repeat(64))).toBe('busy');
    expect(f.recording.manifestRecord()).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
    expect(readFileSync(f.outputPath, 'utf8')).toBe('pulled');
    expect(existsSync(f.secondPath)).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['native check', false],
  ['native check', true],
  ['durable transition', false],
  ['durable transition', true],
] as const)(
  'a missing second chunk at the first %s is refused (release available: %s)',
  async (point, releaseAvailable) => {
    vi.useFakeTimers();
    try {
      const f = await startTwoChunkRecording({
        releaseAvailable,
        deleteBeforeNativeCheck: point === 'native check',
        deleteBeforeTransition: point === 'durable transition',
      });
      const finishing = f.recording.finish();
      await Promise.all([
        vi.advanceTimersByTimeAsync(2_000),
        expect(finishing).rejects.toMatchObject({
          details: { reason: 'resource-missing', outPath: f.secondPath },
        }),
      ]);
      expect(f.nativeReturned()).toBe(point === 'durable transition');
      expect(readFileSync(f.outputPath, 'utf8')).toBe('pulled');
      expect(existsSync(f.secondPath)).toBe(false);
      expect(f.recording.activeHandle()).toBeDefined();
      expect(f.recording.manifestRecord()).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open' },
      });
      const native = JSON.parse(f.marker());
      expect(native.completion.chunks).toMatchObject([
        { path: f.outputPath },
        { path: f.secondPath },
      ]);
      expect(native.admissionReleased === true).toBe(releaseAvailable);
      expect(await f.transport.acquireAdmission('b'.repeat(64))).toBe(
        releaseAvailable ? 'acquired' : 'busy',
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

test('an unavailable second-chunk probe retains the recording and admission', async () => {
  vi.useFakeTimers();
  try {
    const f = await startTwoChunkRecording({ releaseAvailable: false, secondUnavailable: true });
    const finishing = f.recording.finish();
    await Promise.all([
      vi.advanceTimersByTimeAsync(2_000),
      expect(finishing).rejects.toMatchObject({
        details: { reason: 'owner-unavailable', outPath: f.secondPath },
      }),
    ]);
    expect(readFileSync(f.outputPath, 'utf8')).toBe('pulled');
    expect(readFileSync(f.secondPath, 'utf8')).toBe('pulled');
    expect(f.recording.manifestRecord()).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
    expect(f.recording.activeHandle()).toBeDefined();
    expect(JSON.parse(f.marker()).admissionReleased).toBeUndefined();
    expect(await f.transport.acquireAdmission('b'.repeat(64))).toBe('busy');
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['recording stop', false],
  ['recording stop', true],
  ['generic finish', false],
  ['generic finish', true],
  ['generic recovery', false],
  ['generic recovery', true],
  ['startup preservation', false],
  ['startup preservation', true],
] as const)(
  '%s does not publish a chunk removed after native reattachment (release available: %s)',
  async (entrypoint, releaseAvailable) => {
    vi.useFakeTimers();
    try {
      const f = await startTwoChunkRecording({ releaseAvailable });
      const native = f.finishNative();
      await Promise.all([
        vi.advanceTimersByTimeAsync(2_000),
        expect(native).resolves.toMatchObject({
          status: 'completed',
          ...(releaseAvailable ? {} : { cleanupPending: { status: 'cleanup-pending' } }),
        }),
      ]);
      expect(f.recording.manifestRecord()).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open', metadata: { phase: 'active' } },
      });
      let reachedReattach = false;
      const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
      const scope = {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      };
      const reattach = async (envelope: typeof f.envelope) => {
        const result = await f.runtime.screenRecordingReattach({ envelope });
        expect(result.status).toBe('completed');
        reachedReattach = true;
        rmSync(f.secondPath);
        return result;
      };
      const acquireControl = async () => ({
        reattach,
        cleanup,
        [Symbol.asyncDispose]: async () => {},
      });
      if (entrypoint === 'generic recovery') {
        await expect(
          screenRecordingDurableResource.recoverOne(
            { sessionsDir: f.recording.sessionsDir, scope, acquireControl },
            f.recording.resourcePath,
          ),
        ).resolves.toBe('retained');
      } else if (entrypoint === 'startup preservation') {
        const gateway = {
          bind: async ({ device }: { device: unknown }) => ({
            device,
            owner: localRuntimeOwner('android'),
            facts: {
              device: { family: 'android', kind: 'emulator', providerMode: 'local' },
              operations: {
                screenRecordingReattach: { available: true },
                screenRecordingCleanup: { available: true },
              },
            },
            operations: {
              ...f.runtime,
              screenRecordingReattach: async ({ envelope }: { envelope: typeof f.envelope }) =>
                await reattach(envelope),
            },
            [Symbol.asyncDispose]: async () => {},
          }),
        } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
        await expect(
          recoverScreenRecordingResourceAfterDaemonLock({
            sessionsDir: f.recording.sessionsDir,
            resourcePath: f.recording.resourcePath,
            gateway,
            scope,
            claim: { sessionId: f.envelope.sessionId, device: f.envelope.device },
          }),
        ).resolves.toEqual({
          status: 'retained',
          reason: releaseAvailable ? 'completion-pending' : 'resource-missing',
        });
      } else {
        const params = { resourcePath: f.recording.resourcePath, scope, acquireControl };
        const recovered =
          entrypoint === 'recording stop'
            ? finishRecoveredScreenRecording(params)
            : screenRecordingDurableResource.finishRecovered(params);
        await expect(recovered).rejects.toMatchObject({
          details: { reason: 'resource-missing', outPath: f.secondPath },
        });
      }
      expect(reachedReattach).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      const record = f.recording.manifestRecord();
      expect(record).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open' },
      });
      if (record.status !== 'decoded') throw new Error('Expected open recording');
      expect(record.envelope.metadata?.completion).toBeUndefined();
      expect(JSON.parse(f.marker()).admissionReleased === true).toBe(releaseAvailable);
      expect(await f.transport.acquireAdmission('b'.repeat(64))).toBe(
        releaseAvailable ? 'acquired' : 'busy',
      );
      expect(readFileSync(f.outputPath, 'utf8')).toBe('pulled');
      expect(existsSync(f.secondPath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  },
);

async function startTwoChunkRecording(options: {
  releaseAvailable: boolean;
  deleteBeforeNativeCheck?: boolean;
  deleteBeforeTransition?: boolean;
  secondUnavailable?: boolean;
}) {
  const directory = mkdtempForTestSync('android-two-chunk-export-');
  const input = { ...recordingInput(), outputPath: path.join(directory, 'capture.mp4') };
  const secondPath = path.join(directory, 'capture.part-002.mp4');
  const files = recordingFileStore();
  let marker = '';
  let starts = 0;
  let releaseAvailable = options.releaseAvailable;
  let nativeReturned = false;
  let deleteBeforeNativeCheck = options.deleteBeforeNativeCheck === true;
  const host = recordingHost({
    files,
    start: async ({ remotePath }: { remotePath: string }) => ({
      process: { pid: String(41 + ++starts), remotePath, startTime: '1' },
    }),
    outputs: {
      copy: async ({ from, to }: { from: string; to: string }) => {
        await files.outputs.copy({ from, to });
        if (to === input.outputPath || to === secondPath) writeFileSync(to, files.files.get(to)!);
      },
      inspect: async (filePath: string) => {
        if (filePath === secondPath && options.secondUnavailable) return 'unavailable';
        return filePath === input.outputPath || filePath === secondPath
          ? existsSync(filePath)
            ? 'present'
            : 'missing'
          : await files.outputs.inspect(filePath);
      },
    },
    writeManifest: async ({ contents }: { contents: string }) => {
      marker = contents;
    },
    readManifest: async () =>
      marker ? { status: 'read' as const, contents: marker } : { status: 'missing' as const },
  });
  const transport = await host.screenRecording.android.resolve(androidRecordingDevice);
  const originalRelease = transport.releaseAdmission.bind(transport);
  vi.spyOn(transport, 'releaseAdmission').mockImplementation(async (request) => {
    const result = releaseAvailable ? await originalRelease(request) : 'unavailable';
    if (deleteBeforeNativeCheck && existsSync(secondPath)) {
      rmSync(secondPath);
      deleteBeforeNativeCheck = false;
    }
    return result;
  });
  const owner = localRuntimeOwner('android');
  const runtime = await bindAndroidScreenRecordingRuntime({
    host,
    device: androidRecordingDevice,
    owner,
    signal: new AbortController().signal,
  });
  const started = await runtime.screenRecordingStart(input);
  const handle = started.pendingHandle.transfer();
  const observingHandle = {
    ...handle,
    finish: async (progress?: Parameters<typeof handle.finish>[0]) => {
      const result = await handle.finish(progress);
      nativeReturned = true;
      if (options.deleteBeforeTransition && result.status === 'completed') rmSync(secondPath);
      return result;
    },
  };
  const recording = await adoptAndroidRecording({
    sessionName: input.sessionId,
    owner,
    pendingHandle: new PendingTransferGuard(observingHandle),
    envelope: started.envelope,
  });
  await vi.advanceTimersByTimeAsync(170_000);
  expect(starts).toBe(2);
  return {
    recording,
    runtime,
    transport,
    envelope: started.envelope,
    outputPath: input.outputPath,
    secondPath,
    marker: () => marker,
    finishNative: () => handle.finish(),
    nativeReturned: () => nativeReturned,
    setReleaseAvailable: (value: boolean) => {
      releaseAvailable = value;
    },
    recoverUnavailable: () =>
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
  };
}

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
    sessionsDir,
  };
}
