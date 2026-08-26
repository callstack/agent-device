import fs from 'node:fs/promises';
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
  emptyAudioProbeResult,
  normalizeAudioProbeRecord,
  type AudioProbeResult,
  type AudioProbeSource,
} from '@agent-device/contracts/audio-probe-result';
import {
  isConfirmedCleanup,
  type CleanupOutcome,
  type FinishOutcome,
  type ReattachOutcome,
} from '@agent-device/contracts/durable-resource';
import type {
  DurableDescriptorCodec,
  HostCommandResult,
  ManagedProcessIdentity,
  RuntimeOwnerRef,
} from '@agent-device/contracts/platform';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';
import { decodeDurableDescriptor } from './durable-descriptor-codec.ts';

const STATUS_APPEARANCE_TIMEOUT_MS = 5_000;
const STATUS_POLL_INTERVAL_MS = 100;

/**
 * Stable reconstruction coordinates for one host audio capture. The helper transport cannot
 * reconstruct live control after daemon loss, so recovery is declared cleanup-only: the marker
 * proves exact process identity for termination, and the status file still yields a completed
 * result when the run finished on its own.
 */
export type HostAudioProbeDescriptor = Readonly<{
  backend: string;
  source: AudioProbeSource;
  sourceCount: number;
  notes: readonly string[];
  statusPath: string;
  startedAt: number;
  durationMs: number;
  bucketMs: number;
  marker?: ManagedProcessIdentity;
}>;

type HostAudioProbeDescriptorDecode = DurableDescriptorCodec<
  HostAudioProbeDescriptor,
  typeof AUDIO_PROBE_RESOURCE_KIND
>['decode'];

const hasValidHostAudioProbeFields = (body: Record<string, unknown>): boolean =>
  isNonEmptyString(body.backend) &&
  (body.source === 'system-audio' || body.source === 'media-elements') &&
  isBoundedInteger(body.sourceCount, 0) &&
  isStringArray(body.notes) &&
  isNonEmptyString(body.statusPath) &&
  isBoundedInteger(body.startedAt, 1) &&
  isBoundedInteger(body.durationMs, 1) &&
  isBoundedInteger(body.bucketMs, 1);

const decodeHostAudioProbeDescriptor: HostAudioProbeDescriptorDecode = (body) => {
  const valid = hasValidHostAudioProbeFields(body);
  const marker = valid ? decodeMarker(body.marker) : 'invalid';
  if (!valid || marker === 'invalid') {
    return { status: 'invalid', message: 'Audio probe descriptor body is invalid' };
  }
  const decoded = body as unknown as Omit<HostAudioProbeDescriptor, 'notes' | 'marker'> & {
    notes: readonly string[];
  };
  return {
    status: 'decoded',
    descriptor: Object.freeze({
      backend: decoded.backend,
      source: decoded.source,
      sourceCount: decoded.sourceCount,
      notes: Object.freeze([...decoded.notes]),
      statusPath: decoded.statusPath,
      startedAt: decoded.startedAt,
      durationMs: decoded.durationMs,
      bucketMs: decoded.bucketMs,
      ...(marker === undefined ? {} : { marker }),
    }),
  };
};

export const hostAudioProbeDescriptorCodec: DurableDescriptorCodec<
  HostAudioProbeDescriptor,
  typeof AUDIO_PROBE_RESOURCE_KIND
> = Object.freeze({
  resourceKind: AUDIO_PROBE_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: HostAudioProbeDescriptor) => ({
    ...descriptor,
    notes: [...descriptor.notes],
    ...(descriptor.marker === undefined ? {} : { marker: { ...descriptor.marker } }),
  }),
  decode: decodeHostAudioProbeDescriptor,
});

/**
 * Starts the native sampler, waits for its first status publication, and returns the guarded
 * live handle plus the persisted-recovery envelope. A helper that exits before publishing fails
 * the start and leaves nothing to adopt.
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
  try {
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
        ...(process.marker === undefined ? {} : { marker: process.marker }),
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

/**
 * Cleanup-only recovery operations shared by every darwin-hosted owner family. Reattach never
 * reconstructs live control: a finished run reports `completed` from the status file, a live or
 * uncertain sampler stays `unreattachable` for descriptor cleanup to terminate by exact identity.
 */
export function createHostAudioProbeRecoveryOperations(params: {
  host: Pick<HostSystemAudioCaptureHost, 'inspectProcess' | 'terminateProcess'>;
}): Readonly<{
  audioProbeReattach(
    input: AudioProbeReattachInput,
  ): Promise<ReattachOutcome<AudioProbeLiveHandle, AudioProbeCompletion>>;
  audioProbeCleanup(input: AudioProbeReattachInput): Promise<CleanupOutcome>;
}> {
  const { host } = params;
  return Object.freeze({
    audioProbeReattach: async (input) => {
      const decoded = decodeDurableDescriptor(input.envelope, hostAudioProbeDescriptorCodec);
      if (decoded.status !== 'decoded') return decoded;
      const descriptor = decoded.descriptor;
      const liveness = await descriptorProcessLiveness(host, descriptor);
      if (liveness === 'owned-alive') {
        return { status: 'unreattachable', reason: 'transport-not-reattachable' };
      }
      if (liveness === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      const status = await readStatusFile(descriptor);
      if (status === undefined) return { status: 'missing' };
      return {
        status: 'completed',
        result: finalizeStatus(descriptor, status, 'daemon-recovery'),
      };
    },
    audioProbeCleanup: async (input) => {
      const decoded = decodeDurableDescriptor(input.envelope, hostAudioProbeDescriptorCodec);
      if (decoded.status !== 'decoded') {
        return {
          status: 'cleanup-pending',
          reason: 'manual-recovery-required',
          message: decoded.message,
        };
      }
      const descriptor = decoded.descriptor;
      const liveness = await descriptorProcessLiveness(host, descriptor);
      if (liveness === 'ownership-lost') {
        return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      }
      if (liveness === 'missing') return { status: 'already-missing' };
      const terminated = await host.terminateProcess(
        // Liveness above proves the marker exists for the owned-alive arm.
        descriptor.marker as ManagedProcessIdentity,
      );
      if (terminated === 'ownership-lost') {
        return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
      }
      return { status: terminated === 'terminated' ? 'cleaned' : 'already-missing' };
    },
  });
}

async function descriptorProcessLiveness(
  host: Pick<HostSystemAudioCaptureHost, 'inspectProcess'>,
  descriptor: HostAudioProbeDescriptor,
): Promise<'missing' | 'owned-alive' | 'ownership-lost'> {
  if (descriptor.marker === undefined) return 'missing';
  return await host.inspectProcess(descriptor.marker);
}

type StatusIdentity = Pick<
  AudioProbeLiveSnapshot,
  | 'source'
  | 'backend'
  | 'sourceCount'
  | 'notes'
  | 'statusPath'
  | 'startedAt'
  | 'durationMs'
  | 'bucketMs'
>;

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

async function readStatusFile(snapshot: StatusIdentity): Promise<AudioProbeResult | undefined> {
  try {
    const raw = await fs.readFile(snapshot.statusPath, 'utf8');
    return normalizeAudioProbeRecord(JSON.parse(raw), {
      source: snapshot.source,
      backend: snapshot.backend,
      durationMs: snapshot.durationMs,
      elapsedMs: Date.now() - snapshot.startedAt,
      bucketMs: snapshot.bucketMs,
      activeFallback: true,
      sourceCount: snapshot.sourceCount,
      notes: [...snapshot.notes],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function finalizeStatus(
  snapshot: StatusIdentity,
  status: AudioProbeResult | undefined,
  reason: string,
): AudioProbeCompletion {
  const elapsedMs = Math.min(snapshot.durationMs, Math.max(0, Date.now() - snapshot.startedAt));
  const base =
    status ??
    emptyAudioProbeResult({
      source: snapshot.source,
      backend: snapshot.backend,
      durationMs: snapshot.durationMs,
      bucketMs: snapshot.bucketMs,
      sourceCount: snapshot.sourceCount,
      notes: [...snapshot.notes],
    });
  return {
    ...base,
    state: 'stopped',
    active: false,
    elapsedMs,
    stoppedAt: new Date().toISOString(),
    reason,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeMarker(value: unknown): ManagedProcessIdentity | undefined | 'invalid' {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) return 'invalid';
  const marker = value as Record<string, unknown>;
  if (!isBoundedInteger(marker.pid, 1)) return 'invalid';
  if (!isNonEmptyString(marker.startTime)) return 'invalid';
  if (!isNonEmptyString(marker.command)) return 'invalid';
  return Object.freeze({
    pid: marker.pid,
    startTime: marker.startTime,
    command: marker.command,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isBoundedInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
