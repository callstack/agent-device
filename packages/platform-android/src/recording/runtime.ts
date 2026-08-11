import path from 'node:path';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  PlatformRuntimeHost,
  RuntimeOwnerRef,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import {
  PendingTransferGuard,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/platform';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
  encodeDurableDescriptor,
} from '@agent-device/capture-kit';
import {
  androidScreenRecordingDescriptorCodec,
  createNativeManifest,
  type NativeChunk,
} from './manifest.ts';
import { rollbackChunks, stopChunk } from './chunks.ts';
import { persistNativeManifest, startInitialTransaction, startPendingChunk } from './launch.ts';
import { snapshot } from './completion.ts';
import { finalizeAndroidRecording } from './finalize.ts';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import { cleanupAndroidRecording, reattachAndroidRecording, readLiveEvidence } from './recovery.ts';

const ROTATE_AFTER_MS = 170_000;

export async function bindAndroidScreenRecordingRuntime(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): Promise<ScreenRecordingRuntimeOperations> {
  const { host, device, owner, signal } = params;
  const transport = await host.screenRecording.android.resolve(device);
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startAndroidRecording({ host, transport, device, owner, input, signal }),
    screenRecordingReattach: async (input) =>
      await reattachAndroidRecording({ host, transport, device, input }),
    screenRecordingCleanup: async (input) =>
      await cleanupAndroidRecording({ transport, device, input }),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}) {
  const { host, transport, device, owner, input, signal } = params;
  signal.throwIfAborted();
  const startedAt = Date.now();
  const initial = await startInitialTransaction({
    transport,
    device,
    input,
    startedAt,
    signal,
    prepareOutput: async () => await host.screenRecording.outputs.prepare(input.outputPath),
  });
  const manifestPath = initial.manifestPath;
  let chunks: NativeChunk[] = [initial.chunk];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rotation: Promise<void> | undefined;
  let rotationFailure: unknown;
  let nativeCleanupConfirmed = false;
  const schedule = () => {
    timer = setTimeout(() => {
      rotation = rotate().catch((error: unknown) => {
        rotationFailure = error;
      });
    }, ROTATE_AFTER_MS);
    timer.unref?.();
  };
  const rotate = async () => {
    const previous = chunks.at(-1);
    if (!previous) throw new Error('Android recording has no active chunk');
    let previousStopped = false;
    let next: NativeChunk;
    try {
      next = await startPendingChunk({
        transport,
        device,
        input,
        startedAt,
        chunks,
        manifestPath,
        preferredDir: path.posix.dirname(previous.remotePath),
      });
    } catch (concurrentStartError) {
      await stopChunk(transport, previous);
      previousStopped = true;
      try {
        next = await startPendingChunk({
          transport,
          device,
          input,
          startedAt,
          chunks,
          manifestPath,
          preferredDir: path.posix.dirname(previous.remotePath),
        });
      } catch (sequentialStartError) {
        throw sequentialStartError instanceof Error ? sequentialStartError : concurrentStartError;
      }
    }
    const nextChunks = [...chunks, { ...next, index: chunks.length + 1 }];
    try {
      await persistNativeManifest(
        transport,
        manifestPath,
        createNativeManifest(device, input, startedAt, nextChunks, undefined, transport.mode),
      );
    } catch (error) {
      await rollbackChunks(transport, [next]).catch(() => {});
      if (!previousStopped) {
        try {
          await persistNativeManifest(
            transport,
            manifestPath,
            createNativeManifest(device, input, startedAt, chunks, undefined, transport.mode),
          );
        } catch {
          await stopChunk(transport, previous).catch(() => {});
          await persistNativeManifest(
            transport,
            manifestPath,
            createNativeManifest(device, input, startedAt, chunks, next.remotePath, transport.mode),
          ).catch(() => {});
        }
      } else {
        await persistNativeManifest(
          transport,
          manifestPath,
          createNativeManifest(device, input, startedAt, chunks, next.remotePath, transport.mode),
        ).catch(() => {});
      }
      throw error;
    }
    chunks = nextChunks;
    if (!previousStopped) await stopChunk(transport, previous);
    schedule();
  };
  schedule();
  const handle = createScreenRecordingLiveHandle(snapshot(input, startedAt), {
    finish: async (current) => {
      if (timer) clearTimeout(timer);
      await rotation;
      if (rotationFailure) throw rotationFailure;
      const outcome = await finalizeAndroidRecording({
        host,
        transport,
        evidence: createNativeManifest(device, input, startedAt, chunks, undefined, transport.mode),
        manifestPath,
        recording: current,
      });
      nativeCleanupConfirmed = true;
      return outcome;
    },
    forceCleanup: async () => {
      if (timer) clearTimeout(timer);
      if (nativeCleanupConfirmed) return { status: 'cleaned' } as const;
      try {
        await rotation;
      } catch (error) {
        rotationFailure = error;
      }
      const evidence = await readLiveEvidence({
        transport,
        deviceId: device.id,
        sessionId: input.sessionId,
        fence: input.fence,
        manifestPath,
      });
      if (!evidence) return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      return await cleanupVerifiedAndroidEvidence(transport, evidence, manifestPath);
    },
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(androidScreenRecordingDescriptorCodec, {
        backend: 'adb-screenrecord',
        manifestPath,
        outputPath: input.outputPath,
        ...(input.clientOutputPath === undefined
          ? {}
          : { clientOutputPath: input.clientOutputPath }),
        scope: input.scope,
        showTouches: input.showTouches,
        recordOnlySession: input.recordOnlySession,
        ...(input.activeSessionApp === undefined
          ? {}
          : { activeSessionApp: input.activeSessionApp }),
        ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
        transportMode: transport.mode,
      }),
    }),
  });
}
