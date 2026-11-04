import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { decodeNativeManifest, type NativeManifest } from './manifest.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export class AndroidMarkerWriteNotStarted extends AppError {
  constructor() {
    super('COMMAND_FAILED', 'Android recording marker could not be prepared', {
      reason: 'native_recording_marker_not_written',
    });
  }
}

export async function persistNativeManifest(
  transport: Transport,
  manifestPath: string,
  evidence: NativeManifest,
  signal?: AbortSignal,
  create = false,
): Promise<void> {
  const read = await transport.readManifest(manifestPath, signal);
  let next = evidence;
  if (read.status === 'unavailable') throw new AndroidMarkerWriteNotStarted();
  if (create ? read.status !== 'missing' : read.status !== 'read')
    throw new Error('Android recording marker changed');
  if (read.status === 'read') {
    const current = decodeNativeManifest(read.contents);
    if (
      !current ||
      current.fenceToken !== evidence.fenceToken ||
      current.fenceGeneration !== evidence.fenceGeneration ||
      current.claimToken !== evidence.claimToken ||
      current.deviceId !== evidence.deviceId ||
      current.sessionId !== evidence.sessionId ||
      current.launchDisposition === 'canceled'
    )
      throw new Error('Android recording marker ownership changed');
    if (evidence.admissionReleased && !current.admissionReleased)
      throw new Error('Android recording admission receipt changed');
    if (current.admissionReleased) {
      if (
        evidence.pendingRemotePath !== undefined ||
        evidence.launchDisposition !== undefined ||
        JSON.stringify(current.chunks) !== JSON.stringify(evidence.chunks) ||
        (current.completion !== undefined &&
          JSON.stringify(current.completion) !== JSON.stringify(evidence.completion))
      )
        throw new Error('Android recording admission is already released');
      next = { ...evidence, admissionReleased: true };
    }
  }
  const outcome = await transport.compareAndSetManifest(
    {
      manifestPath,
      expected: read.status === 'read' ? read.contents : null,
      contents: JSON.stringify(next),
    },
    signal,
  );
  if (outcome === 'failed' && create) throw new AndroidMarkerWriteNotStarted();
  if (outcome !== 'updated') throw new Error('Android recording marker update unconfirmed');
}

export async function removeNativeManifest(
  transport: Transport,
  manifestPath: string,
  expected: string,
): Promise<void> {
  const outcome = await transport.compareAndSetManifest({ manifestPath, expected, contents: null });
  if (outcome !== 'updated') throw new Error('Android recording marker removal unconfirmed');
}
