import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { provesAndroidScreenRecordPathUnclaimed } from '@agent-device/contracts/screen-recording-runtime-host';
import { candidateRemotePaths, cleanupChunks } from './chunks.ts';
import { decodeNativeManifest, type NativeManifest } from './manifest.ts';
import { removeNativeManifest } from './manifest-store.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;
type ManifestCandidate = Readonly<{
  manifestPath: string;
  read: Awaited<ReturnType<Transport['readManifest']>>;
}>;
type RetireableCandidate = Readonly<{ manifestPath: string; evidence: NativeManifest }>;

/**
 * A marker outlives the native cleanup that would have removed it, and a later start is the only
 * operation that always looks at it. Retire what nothing can recover any more and refuse what
 * somebody still can: open evidence on this device identity still belongs to a live session or to
 * its daemon's recovery, and unreadable evidence cannot be verified at all.
 */
export async function reconcileStartEvidence(
  transport: Transport,
  device: DeviceInfo,
): Promise<void> {
  const candidates = await readManifestCandidates(transport);
  const retireable = candidates.flatMap((candidate) =>
    retireableCandidate(candidate, device, transport.mode),
  );
  for (const candidate of retireable) {
    await retireEvidence(transport, candidate.evidence, candidate.manifestPath);
  }
}

async function readManifestCandidates(transport: Transport): Promise<readonly ManifestCandidate[]> {
  return await Promise.all(
    candidateRemotePaths(undefined).map(async (remotePath) => {
      const manifestPath = transport.manifestPathFor(remotePath);
      return { manifestPath, read: await transport.readManifest(manifestPath) };
    }),
  );
}

function retireableCandidate(
  candidate: ManifestCandidate,
  device: DeviceInfo,
  transportMode: NativeManifest['transportMode'],
): readonly RetireableCandidate[] {
  if (candidate.read.status === 'missing') return [];
  if (candidate.read.status !== 'read')
    throw unavailableEvidence(candidate.manifestPath, candidate.read.message);
  const evidence = decodeNativeManifest(candidate.read.contents);
  if (evidence === undefined) throw corruptEvidence(candidate.manifestPath);
  if (evidence.transportMode !== transportMode)
    throw foreignTransportEvidence(candidate.manifestPath, evidence, transportMode);
  if (!isRetireableEvidence(evidence, device))
    throw openEvidenceOnDevice(candidate.manifestPath, evidence, device);
  return [{ manifestPath: candidate.manifestPath, evidence }];
}

/**
 * Terminal evidence is spent: its recorder ended and its terminal result is already in the marker.
 * Evidence written under another device identity has nobody else to retire it either — a durable
 * envelope always names the device identity it was created for, so no session this transport serves
 * can reach it. Only the old identity, which this device no longer has, could still come back for
 * those artifacts, and `proveArtifactsReleased` is what refuses while a recorder here is writing.
 */
function isRetireableEvidence(evidence: NativeManifest, device: DeviceInfo): boolean {
  return evidence.completion !== undefined || evidence.deviceId !== device.id;
}

async function retireEvidence(
  transport: Transport,
  evidence: NativeManifest,
  manifestPath: string,
): Promise<void> {
  await proveArtifactsReleased(transport, evidence);
  await cleanupChunks(transport, evidence.chunks);
  await removePendingArtifact(transport, evidence);
  await removeNativeManifest(transport, manifestPath);
  const confirmed = await transport.readManifest(manifestPath);
  if (confirmed.status !== 'missing') throw retirementUnconfirmed(manifestPath);
}

/**
 * Refuse while any artifact the marker names still has a recorder writing it, or while the device
 * cannot prove that none is. A committed chunk answers with its own identity; an interrupted launch
 * committed none, so the device is asked which recorders write that path.
 */
async function proveArtifactsReleased(
  transport: Transport,
  evidence: NativeManifest,
): Promise<void> {
  for (const chunk of evidence.chunks) {
    const state = await transport.inspect({
      pid: chunk.remotePid,
      remotePath: chunk.remotePath,
      startTime: chunk.remoteStartTime,
    });
    if (provesAndroidScreenRecordPathUnclaimed(state)) continue;
    if (state === 'uncertain') throw unprovenRecorder(chunk.remotePath);
    throw artifactClaimed(
      chunk.remotePath,
      state === 'owned-alive' ? 'named-recorder' : 'other-recorder',
    );
  }
  const pendingPath = evidence.pendingRemotePath;
  if (pendingPath === undefined) return;
  const scan = await transport.probeRunningWriters(pendingPath);
  if (scan.writers.length > 0) throw artifactClaimed(pendingPath, 'other-recorder');
  if (!scan.conclusive) throw unprovenRecorder(pendingPath);
}

async function removePendingArtifact(
  transport: Transport,
  evidence: NativeManifest,
): Promise<void> {
  const pendingPath = evidence.pendingRemotePath;
  if (pendingPath === undefined) return;
  if (!(await transport.remove(pendingPath))) throw artifactRemovalFailed(pendingPath);
}

function unavailableEvidence(manifestPath: string, probeMessage: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord native recovery evidence is unavailable: ${manifestPath}`,
    {
      reason: 'native_recovery_evidence_unavailable',
      manifestPath,
      hint: 'Confirm the device is online and its storage readable, then run record start again.',
    },
    new Error(probeMessage),
  );
}

function corruptEvidence(manifestPath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord native recovery evidence is unreadable: ${manifestPath}`,
    {
      reason: 'native_recovery_evidence_unreadable',
      manifestPath,
      hint: markerRemovalHint(manifestPath),
    },
  );
}

function foreignTransportEvidence(
  manifestPath: string,
  evidence: NativeManifest,
  transportMode: NativeManifest['transportMode'],
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord native recovery evidence was written by the ${evidence.transportMode} transport, not this ${transportMode} one: ${manifestPath}`,
    {
      reason: 'native_recovery_evidence_transport_mismatch',
      manifestPath,
      evidenceTransportMode: evidence.transportMode,
      hint: markerRemovalHint(manifestPath),
    },
  );
}

function openEvidenceOnDevice(
  manifestPath: string,
  evidence: NativeManifest,
  device: DeviceInfo,
): AppError {
  return new AppError(
    'DEVICE_IN_USE',
    `Android screenrecord native recovery evidence already exists: ${manifestPath} (open recording of session "${evidence.sessionId}" on ${device.id})`,
    {
      reason: 'native_recovery_evidence_open',
      manifestPath,
      sessionId: evidence.sessionId,
      // Retrying this start cannot free the marker; only the owning session's stop or close can.
      retriable: false,
      hint: `Run record stop --session ${evidence.sessionId} to retire it, or close that session. If it is already closed, ${markerRemovalHint(manifestPath)}`,
    },
  );
}

function artifactClaimed(
  remotePath: string,
  writer: 'named-recorder' | 'other-recorder',
): AppError {
  const named = writer === 'named-recorder';
  return new AppError(
    'DEVICE_IN_USE',
    `Android screenrecord recovery evidence is retained: ${
      named ? 'its recorder' : 'another recorder'
    } is writing ${remotePath}`,
    {
      reason: 'native_recording_artifact_claimed',
      remotePath,
      writer,
      // A recorder this marker names is a live recording: only its owner's stop frees it. An
      // unmanaged writer ends by itself at Android's 180 second limit, so waiting recovers.
      ...(named ? { retriable: false } : {}),
      hint: named
        ? 'Run record stop for the session that owns that recording before starting another.'
        : 'Android ends any recorder after 180 seconds. Run record start again once that recorder has stopped.',
    },
  );
}

function artifactRemovalFailed(remotePath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord recovery evidence could not remove ${remotePath}`,
    {
      reason: 'native_recording_artifact_removal_failed',
      remotePath,
      hint: 'Confirm the device is online and run record start again.',
    },
  );
}

function retirementUnconfirmed(manifestPath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord recovery evidence removal could not be confirmed: ${manifestPath}`,
    {
      reason: 'native_recovery_evidence_retirement_unconfirmed',
      manifestPath,
      hint: 'Run record start again; the marker is retired from the beginning.',
    },
  );
}

function unprovenRecorder(remotePath: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android screenrecord recovery evidence cannot be safely retired: ${remotePath}`,
    {
      reason: 'native_recording_recorder_unproven',
      remotePath,
      hint: 'Confirm the device is online and run record start again.',
    },
  );
}

function markerRemovalHint(manifestPath: string): string {
  return `no recording session can retire this marker; remove it on the device with \`adb shell rm -f ${manifestPath}\`.`;
}
