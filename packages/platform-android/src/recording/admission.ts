import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';
import type { NativeManifest } from './manifest.ts';
import { decodeNativeManifest } from './manifest.ts';
import { recordingGenerationKey } from './native-path.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export function admissionReleaseUnconfirmed(): AppError {
  return new AppError('COMMAND_FAILED', 'Android recording admission release is unconfirmed', {
    reason: 'cleanup-unconfirmed',
    retriable: true,
    hint: 'Keep the recording recovery record and retry through its original owner.',
  });
}

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
    if (current.admissionReleased === true) return true;
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
    if (!(await releaseExactAdmission(transport, current, manifestPath, read.contents)))
      return false;
    return (
      (await transport.compareAndSetManifest({
        manifestPath,
        expected: read.contents,
        contents: JSON.stringify({ ...current, admissionReleased: true }),
      })) === 'updated'
    );
  } catch {
    return false;
  }
}
