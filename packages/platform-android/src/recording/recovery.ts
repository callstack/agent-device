import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { provesAndroidScreenRecordTermination } from '@agent-device/contracts/screen-recording-runtime-host';
import { createScreenRecordingLiveHandle } from '@agent-device/capture-kit';
import {
  androidScreenRecordingDescriptorCodec,
  decodeNativeManifest,
  nativeManifestMatchesDescriptor,
  nativeManifestMatchesEnvelope,
  type AndroidRecordingDescriptor,
  type NativeManifest,
} from './manifest.ts';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import { nativeChunksDisposition } from './chunks.ts';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import { snapshot } from './live-snapshot.ts';
import { finalizeAndroidRecording } from './finalize.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;
type Envelope = Parameters<
  ScreenRecordingRuntimeOperations['screenRecordingCleanup']
>[0]['envelope'];

export type DescriptorEvidence =
  | Readonly<{ status: 'matched'; evidence: NativeManifest }>
  | Readonly<{ status: 'transport-unavailable' | 'ownership-lost' }>;

async function readDescriptorEvidence(params: {
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  envelope: Envelope;
  descriptor: AndroidRecordingDescriptor;
}): Promise<DescriptorEvidence> {
  const { transport, device, envelope, descriptor } = params;
  if (descriptor.transportMode !== transport.mode) return { status: 'transport-unavailable' };
  const nativeRead = await transport.readManifest(descriptor.manifestPath);
  if (nativeRead.status === 'unavailable') return { status: 'transport-unavailable' };
  const evidence =
    nativeRead.status === 'read' ? decodeNativeManifest(nativeRead.contents) : undefined;
  return evidence &&
    nativeManifestMatchesEnvelope(evidence, device, envelope) &&
    nativeManifestMatchesDescriptor(evidence, descriptor)
    ? { status: 'matched', evidence }
    : { status: 'ownership-lost' };
}

export async function readLiveEvidence(params: {
  transport: Transport;
  deviceId: string;
  sessionId: string;
  fence: ScreenRecordingStartInput['fence'];
  manifestPath: string;
}): Promise<NativeManifest | undefined> {
  const nativeRead = await params.transport.readManifest(params.manifestPath);
  if (nativeRead.status !== 'read') return undefined;
  const evidence = decodeNativeManifest(nativeRead.contents);
  return evidence && liveEvidenceMatches(evidence, params) ? evidence : undefined;
}

function liveEvidenceMatches(
  evidence: NativeManifest,
  expected: Omit<Parameters<typeof readLiveEvidence>[0], 'transport' | 'manifestPath'>,
): boolean {
  return (
    evidence.deviceId === expected.deviceId &&
    evidence.sessionId === expected.sessionId &&
    evidence.fenceToken === expected.fence.token &&
    evidence.fenceGeneration === expected.fence.generation
  );
}

export async function reattachAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingReattach']>[0];
}) {
  const { host, transport, device, input } = params;
  const parsed = androidScreenRecordingDescriptorCodec.decode(input.envelope.descriptor.body);
  if (parsed.status !== 'decoded') return unreattachable('descriptor-invalid');
  const recovered = await readDescriptorEvidence({
    transport,
    device,
    envelope: input.envelope,
    descriptor: parsed.descriptor,
  });
  if (recovered.status !== 'matched')
    return unreattachable(
      recovered.status === 'transport-unavailable'
        ? 'transport-not-reattachable'
        : 'ownership-fence-lost',
    );
  return await reattachEvidence({
    host,
    transport,
    device,
    input,
    descriptor: parsed.descriptor,
    evidence: recovered.evidence,
  });
}

export async function cleanupAndroidRecording(params: {
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingCleanup']>[0];
}): Promise<CleanupOutcome> {
  const parsed = androidScreenRecordingDescriptorCodec.decode(
    params.input.envelope.descriptor.body,
  );
  if (parsed.status !== 'decoded')
    return { status: 'cleanup-pending', reason: 'manual-recovery-required' };
  const recovered = await readDescriptorEvidence({
    transport: params.transport,
    device: params.device,
    envelope: params.input.envelope,
    descriptor: parsed.descriptor,
  });
  if (recovered.status !== 'matched')
    return recovered.status === 'transport-unavailable'
      ? { status: 'cleanup-pending', reason: 'owner-unavailable' }
      : { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
  return await cleanupVerifiedAndroidEvidence(
    params.transport,
    recovered.evidence,
    parsed.descriptor.manifestPath,
  );
}

async function reattachEvidence(params: {
  host: PlatformRuntimeHost;
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingReattach']>[0];
  descriptor: AndroidRecordingDescriptor;
  evidence: NativeManifest;
}) {
  const { host, transport, device, input, descriptor, evidence } = params;
  if (evidence.completion !== undefined) {
    const observed = await observeCompletedEvidence(transport, evidence);
    if (observed.status === 'terminal')
      return {
        status: 'completed' as const,
        // The marker froze its disposition when the chunks were still owed a removal, so the replay
        // answers that field from the device in front of it (ADR 0024 2.3). A recording whose chunks
        // were disposed of while the daemon was down is not still owed a retirement.
        result: {
          ...evidence.completion,
          nativePathDisposition: observed.nativePathDisposition,
        },
      };
    return unreattachable(
      'ownership-fence-lost',
      'Android recording completed evidence still names a live or unverifiable recorder.',
    );
  }
  if (evidence.pendingRemotePath !== undefined)
    return unreattachable(
      'transport-not-reattachable',
      'Android recording launch was interrupted before its process identity was committed.',
    );
  const active = evidence.chunks.at(-1);
  if (!active) return { status: 'missing' as const };
  const running = await transport.inspect({
    pid: active.remotePid,
    remotePath: active.remotePath,
    startTime: active.remoteStartTime,
  });
  // A recorder that is not running is only finished with once the device has *answered* that its
  // artifact is gone: a probe that could not run leaves the recording finishable, so the caller can
  // pull it when the device answers again instead of being told a loss nobody observed (ADR 0024).
  if (running !== 'owned-alive' && (await transport.exists(active.remotePath)) === false)
    return unreattachable(
      'transport-not-reattachable',
      'Android recording process ended before its artifact could be recovered.',
    );
  const inputForHandle = inputFromDescriptor(
    input.envelope.sessionId,
    input.envelope.fence,
    descriptor,
  );
  let nativeCleanupConfirmed = false;
  const handle = createScreenRecordingLiveHandle(snapshot(inputForHandle, evidence.startedAt), {
    finish: async (current, progress) => {
      const outcome = await finalizeAndroidRecording({
        host,
        transport,
        evidence,
        manifestPath: descriptor.manifestPath,
        recording: current,
        startedAtMs: evidence.startedAt,
        reachedLimit: provesAndroidScreenRecordTermination(running),
        progress,
      });
      nativeCleanupConfirmed = true;
      return outcome;
    },
    forceCleanup: async () =>
      nativeCleanupConfirmed
        ? ({ status: 'cleaned' } as const)
        : await cleanupAndroidRecording({ transport, device, input }),
  });
  return { status: 'active' as const, handle };
}

type CompletedEvidenceObservation =
  | Readonly<{ status: 'terminal'; nativePathDisposition: NativePathDisposition }>
  | Readonly<{ status: 'retained' }>;

async function observeCompletedEvidence(
  transport: Transport,
  evidence: NativeManifest,
): Promise<CompletedEvidenceObservation> {
  try {
    for (const chunk of evidence.chunks) {
      if (
        !provesAndroidScreenRecordTermination(
          await transport.inspect({
            pid: chunk.remotePid,
            remotePath: chunk.remotePath,
            startTime: chunk.remoteStartTime,
          }),
        )
      )
        return { status: 'retained' };
    }
    return {
      status: 'terminal',
      nativePathDisposition: await nativeChunksDisposition(transport, evidence.chunks),
    };
  } catch {
    return { status: 'retained' };
  }
}

function inputFromDescriptor(
  sessionId: string,
  fence: ScreenRecordingStartInput['fence'],
  descriptor: AndroidRecordingDescriptor,
): ScreenRecordingStartInput {
  return {
    sessionId,
    outputPath: descriptor.outputPath,
    ...(descriptor.clientOutputPath === undefined
      ? {}
      : { clientOutputPath: descriptor.clientOutputPath }),
    scope: descriptor.scope,
    showTouches: descriptor.showTouches,
    hideTouchesRequested: false,
    recordOnlySession: descriptor.recordOnlySession,
    ...(descriptor.activeSessionApp === undefined
      ? {}
      : { activeSessionApp: descriptor.activeSessionApp }),
    ...(descriptor.exportQuality === undefined ? {} : { exportQuality: descriptor.exportQuality }),
    fence,
  };
}

function unreattachable(
  reason: 'descriptor-invalid' | 'transport-not-reattachable' | 'ownership-fence-lost',
  message?: string,
) {
  return {
    status: 'unreattachable' as const,
    reason,
    ...(message === undefined ? {} : { message }),
  };
}
