import type { CleanupOutcome, PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { cleanupChunks, stopOwnedChunks } from './chunks.ts';
import { pending } from './completion.ts';
import type { NativeManifest } from './manifest.ts';
import { removeNativeManifest } from './launch.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/** Remove only resources named by validated native evidence, retaining it on every uncertainty. */
export async function cleanupVerifiedAndroidEvidence(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<CleanupOutcome> {
  try {
    const pendingPath = evidence.pendingRemotePath;
    const pendingChunks =
      pendingPath === undefined
        ? []
        : (await transport.findRunning(pendingPath)).map((processIdentity) => ({
            index: evidence.chunks.length + 1,
            remotePath: pendingPath,
            remotePid: processIdentity.pid,
            remoteStartTime: processIdentity.startTime,
          }));
    await stopOwnedChunks(transport, [...evidence.chunks, ...pendingChunks]);
    await cleanupChunks(transport, evidence.chunks);
    if (pendingPath !== undefined && !(await transport.remove(pendingPath)))
      throw new Error(`failed to remove Android recording artifact: ${pendingPath}`);
    await removeNativeManifest(transport, manifestPath);
    return { status: 'cleaned' };
  } catch (error) {
    return pending(error);
  }
}
