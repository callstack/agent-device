import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { cleanupChunks, stopOwnedChunks } from './chunks.ts';
import type { NativeChunk, NativeManifest } from './manifest.ts';
import { removeNativeManifest } from './manifest-store.ts';
import { observeRecordedRecorders } from './recorder-status.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/**
 * Committed chunks split by what the device answered for the identity each one recorded.
 * `retired` chunks name a recorder proven gone; a stop could only signal whoever holds that pid now.
 */
type ChunkGroups = Readonly<{
  stoppable: readonly NativeChunk[];
  retired: readonly NativeChunk[];
}>;

/** Remove only resources named by validated native evidence, retaining it on every uncertainty. */
export async function cleanupVerifiedAndroidEvidence(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<CleanupOutcome> {
  try {
    const pendingPath = evidence.pendingRemotePath;
    const groups = await splitByRecorderState(transport, evidence.chunks);
    await stopOwnedChunks(transport, [
      ...groups.stoppable,
      ...(await pendingWriterChunks(transport, evidence)),
    ]);
    await requireReleasedArtifacts(transport, groups.retired);
    await cleanupChunks(transport, evidence.chunks);
    if (pendingPath !== undefined && !(await transport.remove(pendingPath)))
      throw new Error(`failed to remove Android recording artifact: ${pendingPath}`);
    await removeNativeManifest(transport, manifestPath);
    return { status: 'cleaned' };
  } catch (error) {
    return transportFailure(error);
  }
}

/**
 * Splits committed chunks before anything is signalled. Android can hand a recorder's numeric pid to
 * an unrelated process, and that answer is not a licence to signal whoever holds the pid now, so such
 * a chunk is set aside instead of stopped. An absent pid is not: the stop itself reports it as already
 * missing. A recorder that is alive or unverifiable keeps the existing stop path.
 */
async function splitByRecorderState(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<ChunkGroups> {
  const stoppable: NativeChunk[] = [];
  const retired: NativeChunk[] = [];
  for (const chunk of chunks) {
    const [observation] = await observeRecordedRecorders(transport, [chunk]).catch(() => []);
    const state = observation?.state;
    if (state === 'ownership-lost' || state === 'foreign-writer') retired.push(chunk);
    else stoppable.push(chunk);
  }
  return { stoppable, retired };
}

/**
 * Proves a retired chunk's artifact is released, and only once every live recorder this evidence names
 * has been stopped: chunks can share a path, so a sibling's recorder could still be the writer. The
 * first uncertainty is reported after every check ran, because retaining one artifact cannot leave the
 * other recorders of this recording running.
 */
async function requireReleasedArtifacts(
  transport: Transport,
  chunks: readonly NativeChunk[],
): Promise<void> {
  let retained: Error | undefined;
  for (const chunk of chunks) {
    try {
      await requireUnclaimedArtifact(transport, chunk);
    } catch (error) {
      retained ??= error instanceof Error ? error : new Error(String(error));
    }
  }
  if (retained) throw retained;
}

/**
 * Recorders writing an artifact the evidence never committed. An inconclusive scan is retained like
 * any other uncertainty: one identified recorder does not prove the others are gone, and stopping
 * only some of them before deleting would delete under the rest.
 */
async function pendingWriterChunks(
  transport: Transport,
  evidence: NativeManifest,
): Promise<readonly NativeChunk[]> {
  const pendingPath = evidence.pendingRemotePath;
  if (pendingPath === undefined) return [];
  const writers = await transport.probeRunningWriters(pendingPath);
  if (!writers.conclusive) throw unprovenWriters(pendingPath);
  return writers.writers.map((writer, offset) => ({
    index: evidence.chunks.length + 1 + offset,
    remotePath: pendingPath,
    remotePid: writer.pid,
    remoteStartTime: writer.startTime,
  }));
}

async function requireUnclaimedArtifact(transport: Transport, chunk: NativeChunk): Promise<void> {
  const writers = await transport.probeRunningWriters(chunk.remotePath);
  if (!writers.conclusive) throw unprovenWriters(chunk.remotePath);
  const writer = writers.writers.at(0);
  if (writer)
    throw new Error(`Android artifact is still written by pid ${writer.pid}: ${chunk.remotePath}`);
}

function unprovenWriters(remotePath: string): Error {
  return new Error(`cannot list every recorder writing Android artifact: ${remotePath}`);
}

/** A cleanup that could not be finished is retained, never declared done on the tool's own say-so. */
function transportFailure(error: unknown): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'transport-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
