import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { NativeManifest } from './manifest.ts';
import { decodeNativeManifest } from './manifest.ts';
import { recordingGenerationKey } from './native-path.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export function admissionOwner(evidence: NativeManifest): string {
  return recordingGenerationKey({
    deviceId: evidence.deviceId,
    sessionId: evidence.sessionId,
    claimToken: evidence.claimToken,
    fence: { token: evidence.fenceToken, generation: evidence.fenceGeneration },
  });
}

export async function releaseExactAdmission(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
  expected: string | null,
): Promise<boolean> {
  return await transport
    .releaseAdmission({ owner: admissionOwner(evidence), manifestPath, expected })
    .then(
      (outcome) => outcome === 'released' || outcome === 'absent',
      () => false,
    );
}

export async function releaseQuiescentAdmission(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<boolean> {
  try {
    const read = await transport.readManifest(manifestPath);
    if (read.status !== 'read') return false;
    const current = decodeNativeManifest(read.contents);
    if (
      !current ||
      admissionOwner(current) !== admissionOwner(evidence) ||
      current.pendingRemotePath !== undefined
    )
      return false;
    for (const chunk of current.chunks) {
      if (
        (await transport.inspect({
          pid: chunk.remotePid,
          remotePath: chunk.remotePath,
          startTime: chunk.remoteStartTime,
        })) !== 'missing'
      )
        return false;
      const writers = await transport.probeRunningWriters(chunk.remotePath);
      if (!writers.conclusive || writers.writers.length !== 0) return false;
    }
    return await releaseExactAdmission(transport, current, manifestPath, read.contents);
  } catch {
    return false;
  }
}
