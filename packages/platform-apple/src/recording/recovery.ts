import { deviceIdentity, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  CleanupOutcome,
  ReattachOutcome,
  ResourceUnreattachableReason,
} from '@agent-device/contracts/durable-resource';
import type {
  DurableDescriptorCodec,
  DurableResourceEnvelope,
} from '@agent-device/contracts/durable-resource-envelope';
import type {
  ManagedProcessIdentity,
  OwnedProcessRecordScope,
} from '@agent-device/contracts/platform-runtime-host';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import { isRecord } from '@agent-device/kernel/record';
import {
  SCREEN_RECORDING_RESOURCE_KIND,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
  type ScreenRecordingLiveSnapshot,
  type ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';
import {
  RECORDING_FACTS_KEYS,
  recordingFactsAreValid,
} from '@agent-device/capture-kit/recording-facts';
import type { RecordingStopProgress } from '@agent-device/contracts/recording-stop-progress';
import { readStopCheckpoints } from '@agent-device/capture-kit/recording-stop-sequence';

export type AppleScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<
    ScreenRecordingRuntimeHost,
    'apple' | 'finalize' | 'outputs' | 'ownedProcesses'
  >;
}>;

/**
 * The export a simulator recording owes its caller, durable so a `record stop` that lost its daemon
 * mid-export can still produce it. These are the caller-facing facts of the live snapshot, never the
 * recorder's: `outPath` is the path the caller asked for, which is not the descriptor's `outputPath`
 * (that one is where `simctl` writes), and `startedAt` is the launch the duration is measured from.
 *
 * A manifest written before these coordinates existed cannot name an export it never recorded, so
 * the field stays optional and its absence is answered exactly as such a manifest was answered then.
 */
/** The live-snapshot keys a recovered export is described by, which is the caller's own request. */
const SIMULATOR_EXPORT_KEYS = [
  'outPath',
  'startedAt',
  'clientOutPath',
  ...RECORDING_FACTS_KEYS,
] as const;

export type AppleSimulatorExportCoordinates = Pick<
  ScreenRecordingLiveSnapshot,
  (typeof SIMULATOR_EXPORT_KEYS)[number]
>;

export type AppleRecordingDescriptor =
  | Readonly<{
      backend: 'simctl';
      outputPath: string;
      processes: readonly ManagedProcessIdentity[];
      recording?: AppleSimulatorExportCoordinates;
    }>
  | Readonly<{
      backend: 'runner';
      outputPath: string;
      appBundleId: string;
      runnerSessionId: string;
      runnerAuthority: 'local-lease' | 'scoped-provider';
      remotePath?: string;
    }>;

type AppleRecordingDescriptorCodec = DurableDescriptorCodec<
  AppleRecordingDescriptor,
  typeof SCREEN_RECORDING_RESOURCE_KIND
>;

const encodeAppleRecordingDescriptor: AppleRecordingDescriptorCodec['encode'] = (descriptor) => {
  if (descriptor.backend === 'simctl') {
    const encoded: ReturnType<AppleRecordingDescriptorCodec['encode']> = {
      backend: descriptor.backend,
      outputPath: descriptor.outputPath,
      processes: descriptor.processes.map((process) => ({ ...process })),
      ...(descriptor.recording === undefined ? {} : { recording: { ...descriptor.recording } }),
    };
    return encoded;
  }
  const encoded: ReturnType<AppleRecordingDescriptorCodec['encode']> = {
    backend: descriptor.backend,
    outputPath: descriptor.outputPath,
    appBundleId: descriptor.appBundleId,
    runnerSessionId: descriptor.runnerSessionId,
    runnerAuthority: descriptor.runnerAuthority,
    ...(descriptor.remotePath === undefined ? {} : { remotePath: descriptor.remotePath }),
  };
  return encoded;
};

const descriptorCodec: AppleRecordingDescriptorCodec = Object.freeze({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  version: 1,
  encode: encodeAppleRecordingDescriptor,
  decode: (body) => decodeAppleRecordingDescriptor(body),
});

export function createAppleRecordingEnvelope(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  descriptor: AppleRecordingDescriptor;
}) {
  const { device, owner, input, descriptor } = params;
  return createDurableResourceEnvelope({
    resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: deviceIdentity(device),
    owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(descriptorCodec, descriptor),
  });
}

/**
 * The part of a live snapshot that outlives its daemon. What the recorder's own process held — gesture
 * events, the touch reference frame, a runner's clock — is deliberately absent: recovery cannot invent
 * it, and a recovered export states what it could not honour instead of pretending otherwise.
 */
export function simulatorExportCoordinates(
  snapshot: ScreenRecordingLiveSnapshot,
): AppleSimulatorExportCoordinates {
  const coordinates: Partial<AppleSimulatorExportCoordinates> = {};
  for (const key of SIMULATOR_EXPORT_KEYS) {
    if (snapshot[key] !== undefined) Object.assign(coordinates, { [key]: snapshot[key] });
  }
  return coordinates as AppleSimulatorExportCoordinates;
}

export async function cleanupAppleRecording(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  body: Parameters<AppleRecordingDescriptorCodec['decode']>[0],
  sessionId?: string,
): Promise<CleanupOutcome> {
  const decoded = descriptorCodec.decode(body);
  if (decoded.status !== 'decoded' || !descriptorMatchesAppleDevice(device, decoded.descriptor)) {
    return { status: 'cleanup-pending', reason: 'manual-recovery-required' };
  }
  if (decoded.descriptor.backend === 'simctl') {
    return await cleanupSimulator(host, decoded.descriptor.processes, sessionId);
  }
  return await cleanupRunner(host, device, decoded.descriptor);
}

async function cleanupSimulator(
  host: AppleScreenRecordingOperationHost,
  processes: readonly ManagedProcessIdentity[],
  sessionId?: string,
): Promise<CleanupOutcome> {
  const ownership = await Promise.all(
    processes.map(async (marker) => await host.screenRecording.apple.inspectProcess(marker)),
  );
  if (ownership.includes('ownership-lost')) {
    return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
  }
  if (ownership.every((value) => value === 'missing')) {
    if (sessionId !== undefined) {
      host.screenRecording.ownedProcesses.clear(sessionScope(sessionId));
    }
    return { status: 'already-missing' };
  }
  const outcomes = await Promise.all(
    processes.flatMap((marker, index) =>
      ownership[index] === 'owned-alive'
        ? [host.screenRecording.apple.terminateProcess(marker)]
        : [],
    ),
  );
  if (outcomes.includes('ownership-lost')) {
    return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
  }
  if (sessionId !== undefined) {
    host.screenRecording.ownedProcesses.clear(sessionScope(sessionId));
  }
  return outcomes.every((outcome) => outcome === 'already-missing')
    ? { status: 'already-missing' }
    : { status: 'cleaned' };
}

function sessionScope(sessionId: string): OwnedProcessRecordScope {
  return { kind: 'session', sessionId };
}

async function cleanupRunner(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  descriptor: Extract<AppleRecordingDescriptor, { backend: 'runner' }>,
): Promise<CleanupOutcome> {
  try {
    const ownership = await host.screenRecording.apple.inspectRunner(
      device,
      descriptor.runnerSessionId,
      descriptor.runnerAuthority,
    );
    if (ownership === 'missing') return { status: 'already-missing' };
    if (ownership === 'ownership-lost') {
      return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
    }
    await host.screenRecording.apple.runRunner(device, {
      kind: 'stop',
      appBundleId: descriptor.appBundleId,
      runnerSessionId: descriptor.runnerSessionId,
      runnerAuthority: descriptor.runnerAuthority,
    });
    return { status: 'cleaned' };
  } catch (error) {
    return {
      status: 'cleanup-pending',
      reason: 'transport-failed',
      message: error instanceof Error ? error.message : 'Apple recording cleanup failed',
    };
  }
}

/** What a recovered simulator export needs besides the coordinates its manifest kept. */
export type AppleSimulatorExportRestore = Readonly<{
  recording: AppleSimulatorExportCoordinates;
  /** The file `simctl` wrote, or the copy a first attempt already collected. */
  nativePath: string;
  cleanup(): Promise<CleanupOutcome>;
}>;

/**
 * What an envelope allows next. `restore-export` is the answer when the recorder is gone and the export
 * is still reachable: recovery holds the facts and runs no stop, so the runtime that owns the stop
 * sequence builds the handle from them.
 */
export type AppleRecordingReattachment =
  | ReattachOutcome<ScreenRecordingLiveHandle, ScreenRecordingCompletion>
  | (AppleSimulatorExportRestore & Readonly<{ status: 'restore-export' }>);

export async function reattachAppleRecording(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    device: DeviceInfo;
    envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
  }>,
): Promise<AppleRecordingReattachment> {
  const { host, device, envelope } = params;
  const decoded = descriptorCodec.decode(envelope.descriptor.body);
  if (decoded.status !== 'decoded') {
    return unreattachableAppleRecording('descriptor-invalid', decoded.message);
  }
  if (!descriptorMatchesAppleDevice(device, decoded.descriptor)) {
    return unreattachableAppleRecording(
      'descriptor-invalid',
      'Apple screen-recording descriptor does not match the bound device.',
    );
  }
  return decoded.descriptor.backend === 'simctl'
    ? await reattachSimulatorRecording(params, decoded.descriptor)
    : await reattachRunnerRecording(host, device, decoded.descriptor);
}

/**
 * A `simctl` recorder that is proven gone is the ordinary state of a recording whose daemon died,
 * and it says nothing about the file that recorder already wrote (ADR 0024 2.2). The manifest's
 * coordinates plus that file are what a retried `record stop` still owes the caller, so this answers
 * with a handle that finishes the export instead of with a loss nobody observed.
 */
/**
 * A `simctl` recorder that is proven gone is the ordinary state of a recording whose daemon died, and it
 * says nothing about what the export can still become (ADR 0024 2.2). So the answer comes from what a
 * resumed stop would still have to read: nothing when the first attempt journaled a finalization, that
 * copy when it journaled one, and otherwise the recorder's own file. Nothing reachable is reported as a
 * loss.
 */
async function reattachSimulatorRecording(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
  }>,
  descriptor: Extract<AppleRecordingDescriptor, { backend: 'simctl' }>,
): Promise<AppleRecordingReattachment> {
  const ownership = await Promise.all(
    descriptor.processes.map(
      async (marker) => await params.host.screenRecording.apple.inspectProcess(marker),
    ),
  );
  if (!ownership.every((value) => value === 'missing')) {
    return unreattachableAppleRecording(
      'transport-not-reattachable',
      ownership.includes('ownership-lost')
        ? 'Apple recording ownership no longer matches the durable descriptor.'
        : 'Apple screen recordings require exact cleanup after daemon restart.',
    );
  }
  const { recording } = descriptor;
  const source = resumedExportSource(
    readStopCheckpoints(params.envelope.metadata),
    descriptor.outputPath,
  );
  if (
    recording === undefined ||
    (source !== undefined && !(await recordingRemains(params.host, source)))
  ) {
    return { status: 'missing' };
  }
  return {
    status: 'restore-export',
    recording,
    nativePath: descriptor.outputPath,
    cleanup: async () =>
      await cleanupSimulator(params.host, descriptor.processes, params.envelope.sessionId),
  };
}

/**
 * The file a resumed stop will still read, or `undefined` when it will read none. A journaled
 * finalization is replayed as it stands and its copy is then discarded, a step that tolerates the copy
 * already being gone; a journaled copy is what `finalize` runs from; and a stop that journaled neither
 * collects from the recorder's own path again.
 */
function resumedExportSource(
  learned: RecordingStopProgress,
  nativePath: string,
): string | undefined {
  if (learned.finalization !== undefined) return undefined;
  return learned.collectedPath ?? nativePath;
}

async function reattachRunnerRecording(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  descriptor: Extract<AppleRecordingDescriptor, { backend: 'runner' }>,
): Promise<AppleRecordingReattachment> {
  const ownership = await host.screenRecording.apple.inspectRunner(
    device,
    descriptor.runnerSessionId,
    descriptor.runnerAuthority,
  );
  if (ownership === 'missing') return { status: 'missing' };
  return unreattachableAppleRecording(
    'transport-not-reattachable',
    ownership === 'ownership-lost'
      ? 'Apple recording ownership no longer matches the durable descriptor.'
      : 'Apple screen recordings require exact cleanup after daemon restart.',
  );
}

/**
 * Whether the recorder's own file can still become an export. The container sniff is the read-only
 * probe the stop itself runs on its collected copy, and it is the most this step can promise: a file
 * that fails it is exactly the recording a retry would refuse, so nothing is offered for it.
 */
/**
 * Whether a file the resumed stop would read can still become an export. The container sniff is the
 * read-only probe the stop itself runs on that file, and it is the most this step can promise: a file
 * that fails it is exactly the recording a retry would refuse.
 */
async function recordingRemains(
  host: AppleScreenRecordingOperationHost,
  outputPath: string,
): Promise<boolean> {
  try {
    await host.screenRecording.finalize.sniff({ outputPath });
    return true;
  } catch {
    return false;
  }
}

function unreattachableAppleRecording(
  reason: ResourceUnreattachableReason,
  message: string,
): AppleRecordingReattachment {
  return { status: 'unreattachable', reason, message };
}

function decodeAppleRecordingDescriptor(
  body: Parameters<AppleRecordingDescriptorCodec['decode']>[0],
) {
  if (typeof body.outputPath !== 'string' || body.outputPath.length === 0)
    return invalidDescriptor();
  if (body.backend === 'simctl') return decodeSimulatorDescriptor(body, body.outputPath);
  if (body.backend === 'runner') return decodeRunnerDescriptor(body, body.outputPath);
  return invalidDescriptor();
}

function decodeSimulatorDescriptor(body: Record<string, unknown>, outputPath: string) {
  const processes = decodeProcessIdentities(body.processes);
  const recording = readSimulatorExportCoordinates(body.recording);
  if (!processes || recording === 'invalid') return invalidDescriptor();
  return {
    status: 'decoded' as const,
    descriptor: Object.freeze({
      backend: 'simctl' as const,
      outputPath,
      processes,
      ...(recording === undefined ? {} : { recording }),
    }),
  } as const;
}

/**
 * What the durable coordinates have to say for themselves. `invalid` is a manifest whose recording
 * facet cannot be trusted, which is answered exactly like any other unreadable descriptor: no
 * reattach, no cleanup, the record stays for a human.
 */
function readSimulatorExportCoordinates(
  value: unknown,
): AppleSimulatorExportCoordinates | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return isRecord(value) && isWholeExportCoordinates(value)
    ? Object.freeze(value as unknown as AppleSimulatorExportCoordinates)
    : 'invalid';
}

/** The facts a recovered export computes on rather than repeats, whole or absent. */
function isWholeExportCoordinates(
  value: Record<string, unknown>,
): value is AppleSimulatorExportCoordinates {
  return (
    isNonemptyString(value.outPath) &&
    isFiniteNumber(value.startedAt) &&
    isOptionalText(value.clientOutPath) &&
    recordingFactsAreValid(value)
  );
}

function decodeRunnerDescriptor(body: Record<string, unknown>, outputPath: string) {
  if (!isNonemptyString(body.appBundleId)) return invalidDescriptor();
  if (!isNonemptyString(body.runnerSessionId)) return invalidDescriptor();
  if (!isRunnerAuthority(body.runnerAuthority)) return invalidDescriptor();
  if (!isOptionalCanonicalRemotePath(body.remotePath)) return invalidDescriptor();
  return {
    status: 'decoded',
    descriptor: Object.freeze({
      backend: 'runner',
      outputPath,
      appBundleId: body.appBundleId,
      runnerSessionId: body.runnerSessionId,
      runnerAuthority: body.runnerAuthority,
      ...(body.remotePath === undefined ? {} : { remotePath: body.remotePath }),
    }),
  } as const;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || isNonemptyString(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRunnerAuthority(value: unknown): value is 'local-lease' | 'scoped-provider' {
  return value === 'local-lease' || value === 'scoped-provider';
}

function isOptionalCanonicalRemotePath(value: unknown): value is string | undefined {
  return value === undefined || isCanonicalRunnerRemotePath(value);
}

function isCanonicalRunnerRemotePath(value: unknown): value is string {
  return typeof value === 'string' && /^tmp\/agent-device-recording-\d+\.mp4$/.test(value);
}

function descriptorMatchesAppleDevice(
  device: DeviceInfo,
  descriptor: AppleRecordingDescriptor,
): boolean {
  if (device.kind === 'simulator') return descriptor.backend === 'simctl';
  if (descriptor.backend !== 'runner') return false;
  if (device.appleOs === 'macos') return descriptor.remotePath === undefined;
  return isIosFamily(device)
    ? descriptor.remotePath !== undefined && isCanonicalRunnerRemotePath(descriptor.remotePath)
    : descriptor.remotePath === undefined;
}

function decodeProcessIdentities(value: unknown): readonly ManagedProcessIdentity[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const processes = value.filter(
    (candidate): candidate is ManagedProcessIdentity =>
      typeof candidate === 'object' &&
      candidate !== null &&
      Number.isInteger((candidate as { pid?: unknown }).pid) &&
      ((candidate as { pid: number }).pid ?? 0) > 0 &&
      typeof (candidate as { startTime?: unknown }).startTime === 'string' &&
      (candidate as { startTime: string }).startTime.length > 0 &&
      typeof (candidate as { command?: unknown }).command === 'string' &&
      (candidate as { command: string }).command.length > 0,
  );
  return processes.length === value.length ? Object.freeze([...processes]) : undefined;
}

function invalidDescriptor() {
  return { status: 'invalid', message: 'Invalid Apple screen-recording descriptor' } as const;
}
