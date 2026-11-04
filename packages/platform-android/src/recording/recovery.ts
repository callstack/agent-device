import type {
  CleanupOutcome,
  DurableCaptureProgress,
} from '@agent-device/contracts/durable-resource';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
  ScreenRecordingSettlement,
} from '@agent-device/contracts/screen-recording-runtime';
import { provesAndroidScreenRecordTermination } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  createScreenRecordingLiveHandle,
  decodeDurableDescriptor,
} from '@agent-device/capture-kit';
import {
  androidScreenRecordingDescriptorCodec,
  decodeNativeManifest,
  nativeManifestMatchesDescriptor,
  nativeManifestMatchesEnvelope,
  type AndroidRecordingDescriptor,
  type NativeManifest,
} from './manifest.ts';
import { admissionReleaseUnconfirmed, releaseQuiescentAdmission } from './admission.ts';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import {
  AndroidRecordingOwnershipLost,
  nativeChunksDisposition,
  stopOwnedChunksWithObservation,
} from './chunks.ts';
import { mustSignalRecorder } from '@agent-device/contracts/recording-stop-progress';
import {
  readStopCheckpoints,
  writeStopCheckpoint,
} from '@agent-device/capture-kit/recording-stop-sequence';
import type { NativePathDisposition } from '@agent-device/contracts/recording-native-path';
import { snapshot } from './live-snapshot.ts';
import { finalizeAndroidRecording } from './finalize.ts';
import { androidExportAvailability, guardAndroidRecordingExport } from './export-availability.ts';

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
  signal?: AbortSignal;
}): Promise<DescriptorEvidence> {
  const { transport, device, envelope, descriptor } = params;
  if (descriptor.transportMode !== transport.mode) return { status: 'transport-unavailable' };
  const nativeRead = await transport.readManifest(descriptor.manifestPath, params.signal);
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
  claimToken: ScreenRecordingStartInput['claimToken'];
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
    evidence.fenceGeneration === expected.fence.generation &&
    evidence.claimToken === expected.claimToken
  );
}

export async function reattachAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingReattach']>[0];
  signal?: AbortSignal;
}) {
  const { host, transport, device, input, signal } = params;
  const parsed = decodeDurableDescriptor(input.envelope, androidScreenRecordingDescriptorCodec);
  if (parsed.status !== 'decoded') return unreattachable('descriptor-invalid');
  const recovered = await readDescriptorEvidence({
    transport,
    device,
    envelope: input.envelope,
    descriptor: parsed.descriptor,
    signal,
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
    signal,
  });
}

export async function cleanupAndroidRecording(params: {
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingCleanup']>[0];
}): Promise<CleanupOutcome> {
  const parsed = decodeDurableDescriptor(
    params.input.envelope,
    androidScreenRecordingDescriptorCodec,
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
  signal?: AbortSignal;
}) {
  const { host, transport, device, input, descriptor, evidence, signal } = params;
  if (evidence.completion !== undefined) {
    const observed = await observeCompletedEvidence(transport, evidence, signal);
    const released =
      observed.status === 'terminal' &&
      (await releaseQuiescentAdmission(transport, evidence, descriptor.manifestPath));
    const availability = await androidExportAvailability(host, evidence.completion);
    if (availability.status !== 'present')
      return unreattachable(
        availability.status === 'missing' ? 'resource-missing' : 'owner-unavailable',
        'Android recording export is unavailable.',
      );
    return {
      status: 'completed' as const,
      result: {
        ...evidence.completion,
        nativePathDisposition:
          released && observed.status === 'terminal'
            ? observed.nativePathDisposition
            : ('pending' as const),
      },
      ...(released ? {} : { cleanupPending: admissionReleaseUnconfirmed() }),
    };
  }
  if (evidence.pendingRemotePath !== undefined)
    return unreattachable(
      'transport-not-reattachable',
      'Android recording launch was interrupted before its process identity was committed.',
    );
  const active = evidence.chunks.at(-1);
  if (!active) return { status: 'missing' as const };
  const running = await transport.inspect(
    {
      pid: active.remotePid,
      remotePath: active.remotePath,
      startTime: active.remoteStartTime,
    },
    signal,
  );
  // A recorder that is not running is only finished with once the device has *answered* that its
  // artifact is gone: a probe that could not run leaves the recording finishable, so the caller can
  // pull it when the device answers again instead of being told a loss nobody observed (ADR 0024).
  if (running !== 'owned-alive' && (await transport.exists(active.remotePath, signal)) === false)
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
  let exported: Awaited<ReturnType<typeof finalizeAndroidRecording>> | undefined;
  const handle = createScreenRecordingLiveHandle(snapshot(inputForHandle, evidence.startedAt), {
    finish: async (current, progress) => {
      exported ??= await finalizeAndroidRecording({
        host,
        transport,
        evidence,
        manifestPath: descriptor.manifestPath,
        recording: current,
        startedAtMs: evidence.startedAt,
        reachedLimit: provesAndroidScreenRecordTermination(running),
        progress,
      });
      if (!(await releaseQuiescentAdmission(transport, evidence, descriptor.manifestPath))) {
        if (exported.status !== 'completed') return exported;
        return {
          ...exported,
          result: { ...exported.result, nativePathDisposition: 'pending' },
          cleanupPending: admissionReleaseUnconfirmed(),
        };
      }
      nativeCleanupConfirmed = true;
      return exported;
    },
    forceCleanup: async () => {
      if (nativeCleanupConfirmed) return { status: 'cleaned' } as const;
      if (exported?.status === 'completed') {
        if (!(await releaseQuiescentAdmission(transport, evidence, descriptor.manifestPath)))
          return admissionReleaseUnconfirmed();
        nativeCleanupConfirmed = true;
        return { status: 'cleaned' } as const;
      }
      return await cleanupAndroidRecording({ transport, device, input });
    },
  });
  const guarded = guardAndroidRecordingExport(host, handle);
  return {
    status: 'active' as const,
    handle: Object.freeze({
      ...guarded,
      settleForExport: async (progress: DurableCaptureProgress, signal?: AbortSignal) =>
        await settleAndroidRecording({ transport, device, input, descriptor, progress, signal }),
    }),
  };
}

async function settleAndroidRecording(params: {
  transport: Transport;
  device: Parameters<typeof nativeManifestMatchesEnvelope>[1];
  input: Parameters<ScreenRecordingRuntimeOperations['screenRecordingReattach']>[0];
  descriptor: AndroidRecordingDescriptor;
  progress: DurableCaptureProgress;
  signal?: AbortSignal;
}): Promise<ScreenRecordingSettlement> {
  let intentionalStop = false;
  let chunks: NativeManifest['chunks'] = [];
  const stoppedAtMs = Date.now();
  try {
    const { transport, device, input, descriptor } = params;
    const current = await readDescriptorEvidence({
      transport,
      device,
      envelope: input.envelope,
      descriptor,
      signal: params.signal,
    });
    if (current.status !== 'matched')
      return {
        status: 'retained',
        reason: current.status === 'ownership-lost' ? 'ownership-fence-lost' : 'owner-unavailable',
      };
    const evidence = current.evidence;
    chunks = evidence.chunks;
    if (evidence.pendingRemotePath !== undefined || evidence.completion !== undefined)
      return { status: 'retained', reason: 'stop-unconfirmed' };
    if (evidence.chunks.length === 0) return { status: 'retained', reason: 'resource-missing' };
    const liveChunks: NativeManifest['chunks'][number][] = [];
    for (const chunk of evidence.chunks) {
      const state = await transport.inspect(
        {
          pid: chunk.remotePid,
          remotePath: chunk.remotePath,
          startTime: chunk.remoteStartTime,
        },
        params.signal,
      );
      if (state === 'ownership-lost' || state === 'foreign-writer')
        return { status: 'retained', reason: 'ownership-fence-lost' };
      if (state === 'uncertain') return { status: 'retained', reason: 'owner-unavailable' };
      if (state === 'owned-alive') liveChunks.push(chunk);
    }
    const active = evidence.chunks.at(-1);
    const activeWasLive = active !== undefined && liveChunks.includes(active);
    const stopped = await stopOwnedChunksWithObservation(
      transport,
      liveChunks,
      activeWasLive && active !== undefined
        ? () => {
            params.progress.record(
              writeStopCheckpoint({
                activeRecorderSignal: {
                  pid: active.remotePid,
                  startTime: active.remoteStartTime,
                  remotePath: active.remotePath,
                },
                stoppedAtMs,
              }),
            );
          }
        : undefined,
      params.signal,
    );
    intentionalStop = activeWasLive && stopped.activeSignalled;
    for (const chunk of evidence.chunks) {
      const state = await transport.inspect(
        {
          pid: chunk.remotePid,
          remotePath: chunk.remotePath,
          startTime: chunk.remoteStartTime,
        },
        params.signal,
      );
      if (state === 'ownership-lost' || state === 'foreign-writer')
        return { status: 'retained', reason: 'ownership-fence-lost' };
      if (state !== 'missing') return { status: 'retained', reason: 'stop-unconfirmed' };
    }
  } catch (error) {
    return {
      status: 'retained',
      reason:
        error instanceof AndroidRecordingOwnershipLost
          ? 'ownership-fence-lost'
          : 'stop-unconfirmed',
    };
  }
  if (intentionalStop && mustSignalRecorder(readStopCheckpoints(params.progress.learned))) {
    params.progress.record(
      writeStopCheckpoint({ observation: { recorder: 'confirmed' }, stoppedAtMs }),
    );
  }
  try {
    for (const chunk of chunks) {
      const exists = await params.transport.exists(chunk.remotePath, params.signal);
      if (exists === false) return { status: 'retained', reason: 'resource-missing' };
      if (exists === 'uncertain') return { status: 'retained', reason: 'owner-unavailable' };
    }
  } catch {
    return { status: 'retained', reason: 'owner-unavailable' };
  }
  const latest = await readDescriptorEvidence({
    transport: params.transport,
    device: params.device,
    envelope: params.input.envelope,
    descriptor: params.descriptor,
    signal: params.signal,
  }).catch(() => ({ status: 'transport-unavailable' as const }));
  if (latest.status !== 'matched')
    return {
      status: 'retained',
      reason: latest.status === 'ownership-lost' ? 'ownership-fence-lost' : 'owner-unavailable',
    };
  if (
    !(await releaseQuiescentAdmission(
      params.transport,
      latest.evidence,
      params.descriptor.manifestPath,
    ))
  )
    return { status: 'retained', reason: 'owner-unavailable' };
  return { status: 'export' };
}

type CompletedEvidenceObservation =
  | Readonly<{ status: 'terminal'; nativePathDisposition: NativePathDisposition }>
  | Readonly<{ status: 'retained' }>;

async function observeCompletedEvidence(
  transport: Transport,
  evidence: NativeManifest,
  signal?: AbortSignal,
): Promise<CompletedEvidenceObservation> {
  try {
    for (const chunk of evidence.chunks) {
      if (
        !provesAndroidScreenRecordTermination(
          await transport.inspect(
            {
              pid: chunk.remotePid,
              remotePath: chunk.remotePath,
              startTime: chunk.remoteStartTime,
            },
            signal,
          ),
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
    ...(descriptor.fps === undefined ? {} : { fps: descriptor.fps }),
    fence,
  };
}

function unreattachable(
  reason:
    | 'descriptor-invalid'
    | 'transport-not-reattachable'
    | 'ownership-fence-lost'
    | 'resource-missing'
    | 'owner-unavailable',
  message?: string,
) {
  return {
    status: 'unreattachable' as const,
    reason,
    ...(message === undefined ? {} : { message }),
  };
}
