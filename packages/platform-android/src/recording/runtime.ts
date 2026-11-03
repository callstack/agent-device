import path from 'node:path';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import {
  type ScreenRecordingRuntimeOperations,
  type ScreenRecordingStartInput,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
  encodeDurableDescriptor,
} from '@agent-device/capture-kit';
import {
  androidScreenRecordingDescriptorCodec,
  createNativeManifest,
  recordingRequestFields,
  type NativeChunk,
} from './manifest.ts';
import { AndroidScreenRecordingStopClaimed, rollbackChunks, stopChunk } from './chunks.ts';
import { startInitialTransaction, startPendingChunk } from './launch.ts';
import { persistNativeManifest } from './manifest-store.ts';
import { snapshot } from './live-snapshot.ts';
import { finalizeAndroidRecording } from './finalize.ts';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import { cleanupAndroidRecording, reattachAndroidRecording, readLiveEvidence } from './recovery.ts';

const ROTATE_AFTER_MS = 170_000;

/**
 * The rotation lifecycle of one recording. `recording` may still start a chunk, `stopping` has been
 * asked to stop and is settling the rotation it accepted, `finished` has committed its native
 * evidence. Only `claimStop` and `confirmNativeCleanup` move it, so one owner decides whether a
 * rotation may still start a chunk on the device.
 */
type RecordingPhase = 'recording' | 'stopping' | 'finished';

export async function bindAndroidScreenRecordingRuntime(params: {
  host: PlatformRuntimeHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): Promise<ScreenRecordingRuntimeOperations> {
  const { host, device, owner, signal } = params;
  const transport = await host.screenRecording.android.resolve(device);
  return Object.freeze({
    screenRecordingStart: async (input) =>
      await startAndroidRecording({ host, transport, device, owner, input, signal }),
    screenRecordingReattach: async (input) =>
      await reattachAndroidRecording({ host, transport, device, input }),
    screenRecordingCleanup: async (input) =>
      await cleanupAndroidRecording({ transport, device, input }),
  } satisfies ScreenRecordingRuntimeOperations);
}

async function startAndroidRecording(params: {
  host: PlatformRuntimeHost;
  transport: Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}) {
  const { host, transport, device, owner, input, signal } = params;
  signal.throwIfAborted();
  void host.screenRecording.finalize.prepare({ container: 'mp4' }).catch(() => {});
  const startedAt = Date.now();
  const initial = await startInitialTransaction({
    transport,
    device,
    input,
    startedAt,
    signal,
    prepareOutput: async () => await host.screenRecording.outputs.prepare(input.outputPath),
  });
  const manifestPath = initial.manifestPath;
  let chunks: NativeChunk[] = [initial.chunk];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rotation: Promise<void> | undefined;
  let rotationFailure: unknown;
  let phase: RecordingPhase = 'recording';
  /**
   * Whether a rotation retired the active chunk's recorder itself, confirmed by that stop, and then
   * withdrew without replacing it. Finalization must read that recorder's absence as this recording's
   * own retirement, not as the platform's 180 s limit cutting a recorder short. A retirement that
   * found the recorder already gone is not this recording's doing and records nothing.
   */
  let retiredActiveRecorder = false;
  /**
   * The recording's launch admission. It is aborted the moment either stop operation begins, so the
   * launch owner refuses at the device call it is about to make and a claimed stop never starts
   * another recorder. The commit boundary deliberately does not use it: aborting the host command
   * cannot prove the on-device rename did not happen, so only that write's real outcome decides what
   * the marker holds.
   */
  const stopAdmission = new AbortController();
  /**
   * Stops accepting rotations and arms nothing that could start one. The claim is synchronous, so the
   * rotation already in flight cannot launch a chunk behind the stop that interrupted it. A commit
   * already in flight may still commit, and the stop collects that chunk like any other.
   */
  const claimStop = () => {
    if (timer) clearTimeout(timer);
    stopAdmission.abort();
    if (phase === 'recording') phase = 'stopping';
  };
  const acceptsRotations = () => phase === 'recording';
  /** Marks the native evidence settled, which is the only way out of `stopping`. */
  const confirmNativeCleanup = () => {
    phase = 'finished';
  };
  const schedule = () => {
    if (!acceptsRotations()) return;
    timer = setTimeout(() => {
      rotation = rotate().catch((error: unknown) => {
        rotationFailure = error;
      });
    }, ROTATE_AFTER_MS);
    timer.unref?.();
  };
  /**
   * The active marker for the chunk set the recording currently owns. `pendingRemotePath` names a
   * recorder the device holds that the marker has not committed, which is what keeps a chunk started
   * during a claimed stop, or one whose rollback is unconfirmed, recoverable.
   */
  const activeEvidence = (chunkList: readonly NativeChunk[], pendingRemotePath?: string) =>
    createNativeManifest(device, input, startedAt, chunkList, pendingRemotePath, transport.mode);
  const launchChunk = async (previous: NativeChunk) =>
    await startPendingChunk({
      transport,
      device,
      input,
      startedAt,
      chunks,
      manifestPath,
      preferredDir: path.posix.dirname(previous.remotePath),
      launchAdmission: stopAdmission.signal,
    });
  /**
   * Launches the next chunk, falling back to a sequential launch when the device refuses a second
   * concurrent recorder. Reports whether that fallback had to retire the chunk being replaced.
   */
  const launchRotationChunk = async (
    previous: NativeChunk,
  ): Promise<Readonly<{ chunk: NativeChunk; previousStopped: boolean }>> => {
    try {
      return { chunk: await launchChunk(previous), previousStopped: false };
    } catch (concurrentStartError) {
      // The stop refused this rotation before it dispatched anything. It must not retire the chunk
      // being replaced either: the stop owns that recorder now.
      if (concurrentStartError instanceof AndroidScreenRecordingStopClaimed)
        throw concurrentStartError;
      // The stop owns the current recorder now, so do not begin retiring it for a replacement this
      // recording has already given up on. Finalization will stop it like any active chunk.
      if (stopAdmission.signal.aborted) throw new AndroidScreenRecordingStopClaimed();
      // Retiring this recorder is this recording's own doing, so a later finalization must not read
      // its absence as the platform's 180 s limit, whether or not the replacement this retirement was
      // made for ever launches. Only a stop that confirmed the recorder was live counts: one already
      // gone means the recorder ended on its own, and that disclosure must survive this rotation.
      if (!(await stopChunk(transport, previous))) retiredActiveRecorder = true;
      try {
        return { chunk: await launchChunk(previous), previousStopped: true };
      } catch (sequentialStartError) {
        throw sequentialStartError instanceof Error ? sequentialStartError : concurrentStartError;
      }
    }
  };
  /**
   * Gives up a chunk the stop refused while it was launching, so its recorder cannot outlive the
   * recording. An abandoned chunk that cannot be cleaned is a rotation failure: the marker still
   * names it as pending, and only disposal may then settle it.
   */
  const abandonUncommittedChunk = async (chunk: NativeChunk) => {
    await rollbackChunks(transport, [chunk]);
    await persistNativeManifest(transport, manifestPath, activeEvidence(chunks)).catch(() => {});
  };
  /**
   * Rewinds the marker to what the recording was before this rotation, once its commit failed. The
   * child may never be dropped from the evidence: when its rollback cannot be confirmed, the marker
   * names its path as pending, which is what keeps an unaccounted recorder recoverable and makes the
   * rotation failure the stop reports rather than a clean finish.
   */
  const undoRotationCommit = async (
    next: NativeChunk,
    previous: NativeChunk,
    previousStopped: boolean,
  ): Promise<void> => {
    const rollbackUncertain = await rollbackChunks(transport, [next]).then(
      () => false,
      () => true,
    );
    // An uncertain rollback leaves the child's recorder, its artifact, or both on the device, so the
    // marker must keep naming them as pending.
    if (rollbackUncertain || previousStopped) {
      await persistNativeManifest(
        transport,
        manifestPath,
        activeEvidence(chunks, next.remotePath),
      ).catch(() => {});
      return;
    }
    try {
      await persistNativeManifest(transport, manifestPath, activeEvidence(chunks));
    } catch {
      // The recorder this rotation was replacing is the only writer left, so the marker names the
      // abandoned chunk as pending rather than claiming a chunk set the device no longer holds.
      await stopChunk(transport, previous).catch(() => {});
      await persistNativeManifest(
        transport,
        manifestPath,
        activeEvidence(chunks, next.remotePath),
      ).catch(() => {});
    }
  };
  const rotate = async () => {
    const previous = chunks.at(-1);
    if (!previous) throw new Error('Android recording has no active chunk');
    let next: NativeChunk;
    let previousStopped: boolean;
    try {
      ({ chunk: next, previousStopped } = await launchRotationChunk(previous));
    } catch (error) {
      // The stop outran this rotation before it dispatched a device start. It launched nothing, so
      // the stop owns the recording's evidence and this is not a rotation failure.
      if (error instanceof AndroidScreenRecordingStopClaimed) return;
      throw error;
    }
    if (!acceptsRotations()) {
      await abandonUncommittedChunk(next);
      return;
    }
    const nextChunks = [...chunks, { ...next, index: chunks.length + 1 }];
    try {
      // No stop signal reaches this write. Aborting the host command cannot undo the on-device rename
      // or prove it never ran, so the write runs to its real outcome: success means the device
      // committed the chunk, whatever the stop did while the write was in flight.
      await persistNativeManifest(transport, manifestPath, activeEvidence(nextChunks));
    } catch (error) {
      await undoRotationCommit(next, previous, previousStopped);
      throw error;
    }
    // The write committed this chunk on the device, so the recording keeps it and the stop collects
    // it like every other committed chunk. A committed chunk is never discarded.
    chunks = nextChunks;
    // The active chunk is this freshly launched one now, so a retirement recorded earlier can no
    // longer explain its absence.
    retiredActiveRecorder = false;
    if (!previousStopped) await stopChunk(transport, previous);
    schedule();
  };
  schedule();
  const handle = createScreenRecordingLiveHandle(snapshot(input, startedAt), {
    finish: async (current, progress) => {
      claimStop();
      await rotation;
      if (rotationFailure) throw rotationFailure;
      const outcome = await finalizeAndroidRecording({
        host,
        transport,
        evidence: activeEvidence(chunks),
        manifestPath,
        recording: current,
        startedAtMs: initial.startedAtMs,
        progress,
        activeRecorderRetired: retiredActiveRecorder,
      });
      confirmNativeCleanup();
      return outcome;
    },
    forceCleanup: async () => {
      claimStop();
      if (phase === 'finished') return { status: 'cleaned' } as const;
      try {
        await rotation;
      } catch (error) {
        rotationFailure = error;
      }
      const evidence = await readLiveEvidence({
        transport,
        deviceId: device.id,
        sessionId: input.sessionId,
        fence: input.fence,
        manifestPath,
      });
      if (!evidence) return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      return await cleanupVerifiedAndroidEvidence(transport, evidence, manifestPath);
    },
  });
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(androidScreenRecordingDescriptorCodec, {
        backend: 'adb-screenrecord',
        manifestPath,
        ...recordingRequestFields(input),
        transportMode: transport.mode,
      }),
    }),
  });
}
