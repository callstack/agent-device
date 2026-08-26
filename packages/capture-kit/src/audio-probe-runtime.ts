import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  AUDIO_PROBE_RESOURCE_KIND,
  type AudioProbeCompletion,
  type AudioProbeLiveHandle,
  type AudioProbeLiveSnapshot,
  type AudioProbeReattachInput,
  type AudioProbeStartInput,
  type AudioProbeStartResult,
} from '@agent-device/contracts/audio-probe-runtime';
import type {
  HostAudioCaptureProcess,
  HostSystemAudioCaptureHost,
} from '@agent-device/contracts/audio-probe-runtime-host';
import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
  type ReattachOutcome,
} from '@agent-device/contracts/durable-resource';
import type { HostCommandResult, RuntimeOwnerRef } from '@agent-device/contracts/platform';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { hostAudioProbeDescriptorCodec } from './audio-probe-descriptor.ts';
import { createHostAudioProbeRecoveryOperations } from './audio-probe-recovery.ts';
import { finalizeStatus, readStatusFile, type StatusIdentity } from './audio-probe-status.ts';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';

const STATUS_APPEARANCE_TIMEOUT_MS = 5_000;
const STATUS_POLL_INTERVAL_MS = 100;

/**
 * Starts the native sampler, waits for its first status publication, and returns the guarded
 * live handle plus the persisted-recovery envelope. A helper that exits before publishing fails
 * the start and leaves nothing to adopt, and a helper whose exact process identity cannot be
 * resolved is terminated the same way: a markerless capture would be unrecoverable after daemon
 * loss (cleanup could neither prove nor terminate the child), so it must never be published.
 */
export async function startHostAudioProbe(params: {
  host: HostSystemAudioCaptureHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: AudioProbeStartInput;
}): Promise<AudioProbeStartResult> {
  const { host, device, owner, input } = params;
  const startedAt = Date.now();
  const info = host.info;
  const notes = Object.freeze([...info.notes(device)]);
  const snapshot: AudioProbeLiveSnapshot = Object.freeze({
    source: info.source,
    backend: info.backend,
    sourceCount: info.sourceCount,
    notes,
    statusPath: input.statusPath,
    startedAt,
    durationMs: input.durationMs,
    bucketMs: input.bucketMs,
  });
  const process = await host.start({
    durationMs: input.durationMs,
    bucketMs: input.bucketMs,
    statusPath: input.statusPath,
  });
  void process.wait.catch(() => {});
  const marker = process.marker;
  try {
    if (marker === undefined) {
      throw new AppError(
        'COMMAND_FAILED',
        'failed to start host audio probe: the helper process exposed no exact identity, so the capture could not be recovered after daemon loss and was terminated',
      );
    }
    await waitForFirstStatus(snapshot, process);
  } catch (error) {
    await process.terminate().catch(() => {});
    throw error;
  }
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(createHostAudioProbeLiveHandle(snapshot, process)),
    envelope: createDurableResourceEnvelope({
      resourceKind: AUDIO_PROBE_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(hostAudioProbeDescriptorCodec, {
        backend: info.backend,
        source: info.source,
        sourceCount: info.sourceCount,
        notes,
        statusPath: input.statusPath,
        startedAt,
        durationMs: input.durationMs,
        bucketMs: input.bucketMs,
        marker,
      }),
    }),
  });
}

function createHostAudioProbeLiveHandle(
  snapshot: AudioProbeLiveSnapshot,
  process: HostAudioCaptureProcess,
): AudioProbeLiveHandle {
  let finish: Promise<FinishOutcome<AudioProbeCompletion>> | undefined;
  let cleanup: Promise<CleanupOutcome> | undefined;
  let disposal: Promise<void> | undefined;
  const finishProbe = () =>
    (finish ??= (async () => {
      const beforeStop = await readStatusFile(snapshot);
      await process.terminate().catch(() => {});
      await process.wait.catch(() => {});
      return {
        status: 'completed',
        result: finalizeStatus(snapshot, beforeStop, 'stopped'),
      } as const;
    })());
  const forceCleanup = () =>
    (cleanup ??= finish
      ? finish.then(
          async () => ({ status: 'cleaned' }) as const,
          async () => await terminateForCleanup(process),
        )
      : terminateForCleanup(process));
  return Object.freeze({
    inspect: () => snapshot,
    status: async () => {
      const status = await readStatusFile(snapshot);
      return status ?? finalizeStatus(snapshot, undefined, 'not-started');
    },
    finish: finishProbe,
    forceCleanup,
    [Symbol.asyncDispose]: async () => {
      disposal ??= forceCleanup().then(assertConfirmedAudioProbeCleanup);
      await disposal;
    },
  });
}

async function terminateForCleanup(process: HostAudioCaptureProcess): Promise<CleanupOutcome> {
  try {
    await process.terminate();
    await process.wait.catch(() => {});
    return { status: 'cleaned' };
  } catch (error) {
    return {
      status: 'cleanup-pending',
      reason: 'cleanup-unconfirmed',
      message: error instanceof Error ? error.message : 'Audio probe termination failed',
    };
  }
}

function assertConfirmedAudioProbeCleanup(outcome: CleanupOutcome): void {
  if (isConfirmedCleanup(outcome)) return;
  throw new AppError(
    'COMMAND_FAILED',
    outcome.message ?? 'Audio probe cleanup could not be confirmed',
    {
      reason: outcome.reason,
      retriable: outcome.reason !== 'ownership-fence-lost',
      hint: 'Keep audio-probe.resource.json and retry stop through its exact runtime owner.',
    },
  );
}

/**
 * The complete capture-side operation set shared by every darwin-hosted owner family: one start
 * pipeline plus the cleanup-only recovery pair, bound to the owner's exact identity.
 */
export function createHostAudioProbeCaptureOperations(params: {
  host: HostSystemAudioCaptureHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
}): Readonly<{
  audioProbeStart(input: AudioProbeStartInput): Promise<AudioProbeStartResult>;
  audioProbeReattach(
    input: AudioProbeReattachInput,
  ): Promise<ReattachOutcome<AudioProbeLiveHandle, AudioProbeCompletion>>;
  audioProbeCleanup(input: AudioProbeReattachInput): Promise<CleanupOutcome>;
}> {
  const { host, device, owner } = params;
  const recovery = createHostAudioProbeRecoveryOperations({ host });
  return Object.freeze({
    audioProbeStart: async (input: AudioProbeStartInput) =>
      await startHostAudioProbe({ host, device, owner, input }),
    audioProbeReattach: recovery.audioProbeReattach,
    audioProbeCleanup: recovery.audioProbeCleanup,
  });
}

async function waitForFirstStatus(
  snapshot: StatusIdentity,
  process: HostAudioCaptureProcess,
): Promise<void> {
  const deadline = Date.now() + STATUS_APPEARANCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await readStatusFile(snapshot);
    if (status) return;
    const exit = await Promise.race([
      process.wait.then(
        (result) => result,
        (error: unknown) => error,
      ),
      sleep(STATUS_POLL_INTERVAL_MS).then(() => undefined),
    ]);
    if (exit instanceof Error) throw exit;
    if (exit) {
      const result = exit as HostCommandResult;
      const message =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `host audio probe helper exited with code ${result.exitCode ?? 1}`;
      throw new AppError('COMMAND_FAILED', `failed to start host audio probe: ${message}`);
    }
  }
  throw new AppError('COMMAND_FAILED', 'failed to start host audio probe');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
