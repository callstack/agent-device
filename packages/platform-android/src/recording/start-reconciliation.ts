import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { releaseExactAdmission } from './admission.ts';
import { decodeNativeManifest } from './manifest.ts';
import { legacyRecordingMarkerPaths, recordingMarkerPath } from './native-path.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export async function reconcileStartEvidence(transport: Transport): Promise<void> {
  for (const manifestPath of legacyRecordingMarkerPaths()) {
    const read = await transport.readManifest(manifestPath);
    if (read.status === 'unavailable') {
      throw new AppError(
        'COMMAND_FAILED',
        `Android recording evidence is unavailable: ${manifestPath}`,
        {
          reason: 'native_recovery_evidence_unavailable',
          manifestPath,
        },
      );
    }
    if (read.status === 'read') {
      throw new AppError(
        'DEVICE_IN_USE',
        `Legacy Android recording evidence is retained: ${manifestPath}`,
        {
          reason: 'legacy_native_recording_evidence_unproven',
          manifestPath,
        },
      );
    }
  }
}

/** A no-effect proof is limited to this generation's versioned native authority. */
export async function recoverIncompleteAndroidRecordingStart(
  transport: Transport,
  device: DeviceInfo,
  input: Readonly<{
    sessionId: string;
    fence: { token: string; generation: number };
    claimToken: string;
  }>,
): Promise<'confirmed-no-effect' | 'retained'> {
  if (typeof input.claimToken !== 'string' || input.claimToken.trim().length === 0)
    return 'retained';
  const generation = { deviceId: device.id, ...input };
  const manifestPath = recordingMarkerPath('/sdcard', generation);
  const read = await transport.readManifest(manifestPath);
  if (read.status === 'missing') return 'retained';
  if (read.status !== 'read') return 'retained';
  const evidence = decodeNativeManifest(read.contents);
  if (
    !evidence ||
    evidence.deviceId !== device.id ||
    evidence.sessionId !== input.sessionId ||
    evidence.fenceToken !== input.fence.token ||
    evidence.fenceGeneration !== input.fence.generation ||
    evidence.claimToken !== input.claimToken ||
    evidence.transportMode !== transport.mode ||
    evidence.chunks.length !== 0 ||
    evidence.pendingRemotePath === undefined ||
    evidence.completion !== undefined ||
    (evidence.launchDisposition !== 'armed' &&
      !(evidence.launchDisposition === 'canceled' && evidence.startNoEffectConfirmed === true))
  )
    return 'retained';
  const writers = await transport.probeRunningWriters(evidence.pendingRemotePath);
  if (
    !writers.conclusive ||
    writers.writers.length !== 0 ||
    (await transport.exists(evidence.pendingRemotePath)) !== false
  )
    return 'retained';
  const confirmed = {
    ...evidence,
    launchDisposition: 'canceled' as const,
    startNoEffectConfirmed: true as const,
  };
  const outcome = await transport
    .compareAndSetManifest({
      manifestPath,
      expected: read.contents,
      contents: JSON.stringify(confirmed),
    })
    .catch(() => 'unavailable' as const);
  if (outcome !== 'updated') return 'retained';
  if (!(await releaseExactAdmission(transport, confirmed, manifestPath, JSON.stringify(confirmed))))
    return 'retained';
  return 'confirmed-no-effect';
}
