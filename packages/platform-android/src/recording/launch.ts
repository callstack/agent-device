import type { DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  markScreenRecordingStartNotDispatched,
  type ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import {
  AndroidScreenRecordingStartRollbackUnconfirmed,
  AndroidScreenRecordingStopClaimed,
  candidateRemotePaths,
  rollbackChunks,
  startChunkAt,
} from './chunks.ts';
import { createNativeManifest, type NativeChunk } from './manifest.ts';
import { persistNativeManifest, removeNativeManifest } from './manifest-store.ts';
import { reconcileStartEvidence } from './start-reconciliation.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export async function startInitialTransaction(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  signal: AbortSignal;
  prepareOutput: () => Promise<void>;
}): Promise<Readonly<{ chunk: NativeChunk; manifestPath: string; startedAtMs: number }>> {
  const { transport, device, input, startedAt, signal, prepareOutput } = params;
  try {
    await reconcileStartEvidence(transport, device);
    await prepareOutput();
  } catch (error) {
    throw markScreenRecordingStartNotDispatched(error);
  }
  let last: unknown;
  for (const remotePath of candidateRemotePaths(undefined)) {
    const manifestPath = transport.manifestPathFor(remotePath);
    await persistNativeManifest(
      transport,
      manifestPath,
      createNativeManifest(device, input, startedAt, [], remotePath, transport.mode),
      signal,
    );
    let chunk: NativeChunk;
    let startedAtMs: number;
    try {
      // Timestamp immediately before launching, the way the stop signal is timestamped, so the
      // window a short clip is measured against holds only the recording.
      startedAtMs = Date.now();
      chunk = await startChunkAt(transport, remotePath, input, signal);
    } catch (error) {
      if (signal.aborted) {
        await retireCanceledLaunchMarker(transport, manifestPath, error);
        throw signal.reason;
      }
      await removeFailedCandidateManifest(transport, manifestPath, error);
      last = error;
      continue;
    }
    try {
      await persistNativeManifest(
        transport,
        manifestPath,
        createNativeManifest(device, input, startedAt, [chunk], undefined, transport.mode),
        signal,
      );
    } catch (error) {
      await rollbackPublishedChunk(transport, manifestPath, chunk);
      throw error;
    }
    return { chunk, manifestPath, startedAtMs };
  }
  throw last ?? new Error('Android screenrecord did not begin producing frames');
}

async function retireCanceledLaunchMarker(
  transport: Transport,
  manifestPath: string,
  launchError: unknown,
): Promise<void> {
  // `startChunkAt` has already rolled back the child and its artifact. Retire the pre-launch
  // marker only when that cleanup is confirmed; otherwise leave it for fenced recovery.
  if (launchError instanceof AndroidScreenRecordingStartRollbackUnconfirmed) return;
  await removeNativeManifest(transport, manifestPath).catch(() => {});
}

async function rollbackPublishedChunk(
  transport: Transport,
  manifestPath: string,
  chunk: NativeChunk,
): Promise<void> {
  try {
    await rollbackChunks(transport, [chunk]);
  } catch {
    // Retain the pending marker when native cleanup is uncertain so a fenced recovery can prove
    // ownership before a later start is admitted.
    return;
  }
  await removeNativeManifest(transport, manifestPath).catch(() => {});
}

export async function startPendingChunk(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  chunks: readonly NativeChunk[];
  manifestPath: string;
  preferredDir: string;
  // Refuses a device start once the recording's stop has been claimed.
  launchAdmission: AbortSignal;
}): Promise<NativeChunk> {
  const {
    transport,
    device,
    input,
    startedAt,
    chunks,
    manifestPath,
    preferredDir,
    launchAdmission,
  } = params;
  let last: unknown;
  for (const remotePath of candidateRemotePaths(preferredDir)) {
    if (launchAdmission.aborted) throw new AndroidScreenRecordingStopClaimed();
    await persistNativeManifest(
      transport,
      manifestPath,
      createNativeManifest(device, input, startedAt, chunks, remotePath, transport.mode),
    );
    try {
      // The pending evidence is on the device, but the stop may have been claimed while it was being
      // written. Refuse here rather than dispatch a recorder the recording has already given up.
      if (launchAdmission.aborted) throw new AndroidScreenRecordingStopClaimed();
      return await startChunkAt(transport, remotePath, input);
    } catch (error) {
      if (error instanceof AndroidScreenRecordingStartRollbackUnconfirmed) throw error;
      try {
        // Clears the pending marker, which names a recorder nothing launched when the refusal raised
        // this error.
        await persistNativeManifest(
          transport,
          manifestPath,
          createNativeManifest(device, input, startedAt, chunks, undefined, transport.mode),
        );
      } catch {
        throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
      }
      last = error;
    }
  }
  throw last ?? new Error('failed to start next Android recording chunk');
}

async function removeFailedCandidateManifest(
  transport: Transport,
  manifestPath: string,
  launchError: unknown,
): Promise<void> {
  if (launchError instanceof AndroidScreenRecordingStartRollbackUnconfirmed) throw launchError;
  try {
    await removeNativeManifest(transport, manifestPath);
  } catch {
    throw new AndroidScreenRecordingStartRollbackUnconfirmed(launchError);
  }
}
