import type { DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { ScreenRecordingStartInput } from '@agent-device/contracts/screen-recording-runtime';
import {
  cleanupChunks,
  AndroidScreenRecordingStartRollbackUnconfirmed,
  candidateRemotePaths,
  rollbackChunks,
  startChunkAt,
} from './chunks.ts';
import {
  createNativeManifest,
  decodeNativeManifest,
  type NativeChunk,
  type NativeManifest,
} from './manifest.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;
type ManifestCandidate = Readonly<{
  manifestPath: string;
  read: Awaited<ReturnType<Transport['readManifest']>>;
}>;
type CompletedCandidate = Readonly<{ manifestPath: string; evidence: NativeManifest }>;

export async function startInitialTransaction(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  signal: AbortSignal;
  prepareOutput: () => Promise<void>;
}): Promise<Readonly<{ chunk: NativeChunk; manifestPath: string }>> {
  const { transport, device, input, startedAt, signal, prepareOutput } = params;
  await reconcileCompletedStartEvidence(transport, device);
  await prepareOutput();
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
    try {
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
    return { chunk, manifestPath };
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

/**
 * A terminal marker outlives native cleanup until a later, fenced start reconciles it. Never
 * retire open or uncertain evidence: that would erase the only recovery authority after a crash.
 */
async function reconcileCompletedStartEvidence(
  transport: Transport,
  device: DeviceInfo,
): Promise<void> {
  const candidates = await readManifestCandidates(transport);
  const completed = candidates.flatMap((candidate) =>
    completedCandidate(candidate, device, transport.mode),
  );
  for (const candidate of completed) {
    await retireCompletedEvidence(transport, candidate.evidence, candidate.manifestPath);
  }
}

async function readManifestCandidates(transport: Transport): Promise<readonly ManifestCandidate[]> {
  return await Promise.all(
    candidateRemotePaths(undefined).map(async (remotePath) => {
      const manifestPath = transport.manifestPathFor(remotePath);
      return { manifestPath, read: await transport.readManifest(manifestPath) };
    }),
  );
}

function completedCandidate(
  candidate: ManifestCandidate,
  device: DeviceInfo,
  transportMode: NativeManifest['transportMode'],
): readonly CompletedCandidate[] {
  if (candidate.read.status === 'missing') return [];
  if (candidate.read.status !== 'read') throw unavailableEvidence();
  const evidence = decodeNativeManifest(candidate.read.contents);
  if (!isRetireableCompletedEvidence(evidence, device, transportMode)) throw existingEvidence();
  return [{ manifestPath: candidate.manifestPath, evidence }];
}

function isRetireableCompletedEvidence(
  evidence: NativeManifest | undefined,
  device: DeviceInfo,
  transportMode: NativeManifest['transportMode'],
): evidence is NativeManifest {
  return (
    evidence !== undefined &&
    evidence.completion !== undefined &&
    evidence.pendingRemotePath === undefined &&
    evidence.deviceId === device.id &&
    evidence.transportMode === transportMode
  );
}

function unavailableEvidence(): Error {
  return new Error('Android screenrecord native recovery evidence is unavailable');
}

function existingEvidence(): Error {
  return new Error('Android screenrecord native recovery evidence already exists');
}

async function retireCompletedEvidence(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<void> {
  for (const chunk of evidence.chunks) {
    const state = await transport.inspect({
      pid: chunk.remotePid,
      remotePath: chunk.remotePath,
      startTime: chunk.remoteStartTime,
    });
    if (state !== 'missing')
      throw new Error('Android screenrecord completed evidence cannot be safely retired');
  }
  await cleanupChunks(transport, evidence.chunks);
  await removeNativeManifest(transport, manifestPath);
  const confirmed = await transport.readManifest(manifestPath);
  if (confirmed.status !== 'missing')
    throw new Error('Android screenrecord completed evidence removal could not be confirmed');
}

export async function startPendingChunk(params: {
  transport: Transport;
  device: DeviceInfo;
  input: ScreenRecordingStartInput;
  startedAt: number;
  chunks: readonly NativeChunk[];
  manifestPath: string;
  preferredDir: string;
}): Promise<NativeChunk> {
  const { transport, device, input, startedAt, chunks, manifestPath, preferredDir } = params;
  let last: unknown;
  for (const remotePath of candidateRemotePaths(preferredDir)) {
    await persistNativeManifest(
      transport,
      manifestPath,
      createNativeManifest(device, input, startedAt, chunks, remotePath, transport.mode),
    );
    try {
      return await startChunkAt(transport, remotePath, input);
    } catch (error) {
      if (error instanceof AndroidScreenRecordingStartRollbackUnconfirmed) throw error;
      try {
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

export async function persistNativeManifest(
  transport: Transport,
  manifestPath: string,
  evidence: NativeManifest,
  signal?: AbortSignal,
): Promise<void> {
  await transport.writeManifest({ manifestPath, contents: JSON.stringify(evidence) }, signal);
}

export async function removeNativeManifest(
  transport: Transport,
  manifestPath: string,
): Promise<void> {
  if (!(await transport.removeManifest(manifestPath))) {
    throw new Error(`failed to remove Android recording manifest: ${manifestPath}`);
  }
}
