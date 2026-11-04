import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { releaseExactAdmission, releaseQuiescentAdmission } from './admission.ts';
import { rollbackChunks } from './chunks.ts';
import type { NativeManifest } from './manifest.ts';
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
    if (pendingPath !== undefined && evidence.launchDisposition !== 'canceled')
      throw new Error('Android pending launch ownership is unconfirmed');
    await rollbackChunks(transport, evidence.chunks);
    if (pendingPath !== undefined) {
      const writers = await transport.probeRunningWriters(pendingPath);
      if (!writers.conclusive || writers.writers.length !== 0)
        throw new Error('Android canceled launch writer absence is unconfirmed');
      if ((await transport.exists(pendingPath)) !== false)
        throw new Error('Android canceled launch artifact absence is unconfirmed');
    }
    let expected = JSON.stringify(evidence);
    if (pendingPath === undefined) {
      const read = await transport.readManifest(manifestPath);
      if (read.status !== 'read' || read.contents !== expected)
        throw new Error('Android recording marker changed');
      if (!(await releaseQuiescentAdmission(transport, evidence, manifestPath)))
        throw new Error('Android recording admission release unconfirmed');
      expected = JSON.stringify({ ...evidence, admissionReleased: true });
    } else if (!(await releaseExactAdmission(transport, evidence, manifestPath, expected))) {
      throw new Error('Android recording admission release unconfirmed');
    }
    await removeNativeManifest(transport, manifestPath, expected);
    return { status: 'cleaned' };
  } catch (error) {
    return transportFailure(error);
  }
}

/** A cleanup that could not be finished is retained, never declared done on the tool's own say-so. */
function transportFailure(error: unknown): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
    message: error instanceof Error ? error.message : String(error),
  };
}
