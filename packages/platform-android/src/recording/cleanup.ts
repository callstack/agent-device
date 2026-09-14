import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { cleanupChunks, stopOwnedChunks } from './chunks.ts';
import { pending } from './completion.ts';
import type { NativeChunk, NativeManifest } from './manifest.ts';
import { removeNativeManifest } from './manifest-store.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/** Remove only resources named by validated native evidence, retaining it on every uncertainty. */
export async function cleanupVerifiedAndroidEvidence(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<CleanupOutcome> {
  try {
    const pendingPath = evidence.pendingRemotePath;
    await stopOwnedChunks(transport, [
      ...evidence.chunks,
      ...(await pendingWriterChunks(transport, evidence)),
    ]);
    await cleanupChunks(transport, evidence.chunks);
    if (pendingPath !== undefined && !(await transport.remove(pendingPath)))
      throw new Error(`failed to remove Android recording artifact: ${pendingPath}`);
    await removeNativeManifest(transport, manifestPath);
    return { status: 'cleaned' };
  } catch (error) {
    return pending(error);
  }
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
  if (!writers.conclusive)
    throw new Error(`cannot list every recorder writing Android artifact: ${pendingPath}`);
  return writers.writers.map((writer, offset) => ({
    index: evidence.chunks.length + 1 + offset,
    remotePath: pendingPath,
    remotePid: writer.pid,
    remoteStartTime: writer.startTime,
  }));
}
