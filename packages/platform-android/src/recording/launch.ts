import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import {
  isScreenRecordingStartNotDispatched,
  markScreenRecordingStartNotDispatched,
  ScreenRecordingStartRolledBack,
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
import {
  AndroidMarkerWriteNotStarted,
  persistNativeManifest,
  removeNativeManifest,
} from './manifest-store.ts';
import { reconcileStartEvidence } from './start-reconciliation.ts';
import { recordingGenerationKey, type AndroidRecordingGeneration } from './native-path.ts';
import { releaseExactAdmission } from './admission.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export function markAndroidStartNotDispatched(error: unknown): unknown {
  const marked = markScreenRecordingStartNotDispatched(error);
  if (isScreenRecordingStartNotDispatched(marked)) return marked;
  const normalized =
    error instanceof AppError
      ? new AppError(error.code, error.message, error.details, error.cause)
      : new AppError(
          'COMMAND_FAILED',
          'Android recording start was not dispatched',
          { reason: 'recording-start-not-dispatched' },
          error,
        );
  return markScreenRecordingStartNotDispatched(normalized);
}

export async function startInitialTransaction(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  signal: AbortSignal;
  prepareOutput: () => Promise<void>;
}): Promise<Readonly<{ chunk: NativeChunk; manifestPath: string; startedAtMs: number }>> {
  const { transport, device, input, startedAt, signal, prepareOutput } = params;
  const generation: AndroidRecordingGeneration = {
    deviceId: device.id,
    sessionId: input.sessionId,
    fence: input.fence,
    claimToken: input.claimToken,
  };
  try {
    await reconcileStartEvidence(transport);
  } catch (error) {
    throw markAndroidStartNotDispatched(error);
  }
  try {
    signal.throwIfAborted();
  } catch (error) {
    throw markAndroidStartNotDispatched(error);
  }
  const admission = await transport
    .acquireAdmission(recordingGenerationKey(generation))
    .catch(() => 'unavailable' as const);
  if (admission === 'busy')
    throw markAndroidStartNotDispatched(
      new AppError('DEVICE_IN_USE', 'Android screen recording is already owned on this device', {
        reason: 'android_recording_admission_busy',
      }),
    );
  if (admission !== 'acquired')
    throw new AndroidScreenRecordingStartRollbackUnconfirmed(
      new Error('Android recording admission is unconfirmed'),
    );
  let last: ScreenRecordingStartRolledBack | undefined;
  for (const remotePath of candidateRemotePaths(generation)) {
    const manifestPath = transport.manifestPathFor(remotePath);
    const armed = {
      ...createNativeManifest(device, input, startedAt, [], remotePath, transport.mode),
      launchDisposition: 'armed' as const,
    };
    try {
      signal.throwIfAborted();
      await prepareOutput();
      signal.throwIfAborted();
    } catch (error) {
      if (!(await releaseExactAdmission(transport, armed, manifestPath, null)))
        throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
      throw markAndroidStartNotDispatched(error);
    }
    try {
      await persistNativeManifest(transport, manifestPath, armed, undefined, true);
    } catch (error) {
      if (
        error instanceof AndroidMarkerWriteNotStarted &&
        (await releaseExactAdmission(transport, armed, manifestPath, null))
      )
        throw markAndroidStartNotDispatched(error);
      throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
    }
    try {
      signal.throwIfAborted();
    } catch (error) {
      if (!(await releaseExactAdmission(transport, armed, manifestPath, JSON.stringify(armed))))
        throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
      throw markAndroidStartNotDispatched(error);
    }
    let chunk: NativeChunk;
    const startedAtMs = Date.now();
    try {
      chunk = await startChunkAt(transport, remotePath, input, manifestPath, armed, signal);
    } catch (error) {
      if (!(error instanceof ScreenRecordingStartRolledBack)) throw error;
      await retireRolledBackMarker(transport, manifestPath, armed, undefined, error);
      if (signal.aborted) throw new ScreenRecordingStartRolledBack(signal.reason);
      last = error;
      continue;
    }
    const active = createNativeManifest(
      device,
      input,
      startedAt,
      [chunk],
      undefined,
      transport.mode,
    );
    try {
      await persistNativeManifest(transport, manifestPath, active, signal);
    } catch (error) {
      try {
        await rollbackChunks(transport, [chunk]);
      } catch (error) {
        throw new AndroidScreenRecordingStartRollbackUnconfirmed(error);
      }
      await retireRolledBackMarker(transport, manifestPath, armed, active, error);
      throw new ScreenRecordingStartRolledBack(error);
    }
    return { chunk, manifestPath, startedAtMs };
  }
  throw (
    last ??
    markAndroidStartNotDispatched(new Error('Android screenrecord did not begin producing frames'))
  );
}

async function retireRolledBackMarker(
  transport: Transport,
  manifestPath: string,
  armed: ReturnType<typeof createNativeManifest>,
  active: ReturnType<typeof createNativeManifest> | undefined,
  cause: unknown,
): Promise<void> {
  const read = await transport.readManifest(manifestPath).catch(() => undefined);
  const admitted = JSON.stringify({ ...armed, launchDisposition: 'admitted' });
  if (
    read?.status !== 'read' ||
    (read.contents !== admitted && read.contents !== JSON.stringify(active))
  )
    throw new AndroidScreenRecordingStartRollbackUnconfirmed(cause);
  try {
    if (!(await releaseExactAdmission(transport, armed, manifestPath, read.contents)))
      throw new Error('Android recording admission release unconfirmed');
    await removeNativeManifest(transport, manifestPath, read.contents);
  } catch {
    throw new AndroidScreenRecordingStartRollbackUnconfirmed(cause);
  }
}

export async function startPendingChunk(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  chunks: readonly NativeChunk[];
  manifestPath: string;
  // Refuses a device start once the recording's stop has been claimed.
  launchAdmission: AbortSignal;
}): Promise<NativeChunk> {
  const { transport, device, input, startedAt, chunks, manifestPath, launchAdmission } = params;
  let last: unknown;
  const generation: AndroidRecordingGeneration = {
    deviceId: device.id,
    sessionId: input.sessionId,
    fence: input.fence,
    claimToken: input.claimToken,
  };
  for (const remotePath of candidateRemotePaths(generation)) {
    if (launchAdmission.aborted) throw new AndroidScreenRecordingStopClaimed();
    const armed = {
      ...createNativeManifest(device, input, startedAt, chunks, remotePath, transport.mode),
      launchDisposition: 'armed' as const,
    };
    await persistNativeManifest(transport, manifestPath, armed);
    try {
      // The pending evidence is on the device, but the stop may have been claimed while it was being
      // written. Refuse here rather than dispatch a recorder the recording has already given up.
      if (launchAdmission.aborted) throw new AndroidScreenRecordingStopClaimed();
      return await startChunkAt(transport, remotePath, input, manifestPath, armed);
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
