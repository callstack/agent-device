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
import type { JsonObject } from '@agent-device/contracts/client';
import {
  isRecordingExportQuality,
  isRecordingScope,
  type RecordingAppIdentity,
  type RecordingExportQuality,
  type RecordingScope,
} from '@agent-device/contracts/recording';
import {
  SCREEN_RECORDING_RESOURCE_KIND,
  type ScreenRecordingCompletion,
  type ScreenRecordingLiveHandle,
  type ScreenRecordingLiveSnapshot,
  type ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

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
export type AppleSimulatorExportCoordinates = Readonly<{
  outPath: string;
  startedAt: number;
  clientOutPath?: string;
  scope: RecordingScope;
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: RecordingAppIdentity;
  exportQuality?: RecordingExportQuality;
}>;

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
      ...(descriptor.recording === undefined
        ? {}
        : { recording: encodeSimulatorExportCoordinates(descriptor.recording) }),
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

function encodeSimulatorExportCoordinates(recording: AppleSimulatorExportCoordinates): JsonObject {
  return {
    outPath: recording.outPath,
    startedAt: recording.startedAt,
    ...(recording.clientOutPath === undefined ? {} : { clientOutPath: recording.clientOutPath }),
    scope: recording.scope,
    showTouches: recording.showTouches,
    recordOnlySession: recording.recordOnlySession,
    ...(recording.activeSessionApp === undefined
      ? {}
      : { activeSessionApp: encodeRecordingAppIdentity(recording.activeSessionApp) }),
    ...(recording.exportQuality === undefined ? {} : { exportQuality: recording.exportQuality }),
  };
}

function encodeRecordingAppIdentity(app: RecordingAppIdentity): JsonObject {
  return { bundleId: app.bundleId, ...(app.name === undefined ? {} : { name: app.name }) };
}

/**
 * The caller-facing facts of a live snapshot, which are everything a stop needs in order to produce
 * the same export after the daemon that started the recording is gone. Telemetry the recorder's own
 * process held (gesture events) is deliberately absent: recovery cannot invent it.
 */
export function simulatorExportCoordinates(
  snapshot: ScreenRecordingLiveSnapshot,
): AppleSimulatorExportCoordinates {
  return {
    outPath: snapshot.outPath,
    startedAt: snapshot.startedAt,
    ...(snapshot.clientOutPath === undefined ? {} : { clientOutPath: snapshot.clientOutPath }),
    scope: snapshot.scope,
    showTouches: snapshot.showTouches,
    recordOnlySession: snapshot.recordOnlySession,
    ...(snapshot.activeSessionApp === undefined
      ? {}
      : { activeSessionApp: snapshot.activeSessionApp }),
    ...(snapshot.exportQuality === undefined ? {} : { exportQuality: snapshot.exportQuality }),
  };
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
export type AppleSimulatorRecordingRestore = Readonly<{
  recording: AppleSimulatorExportCoordinates;
  /** The file `simctl` wrote, which a resumed stop collects instead of signalling anything. */
  nativePath: string;
  cleanup(): Promise<CleanupOutcome>;
}>;

export type AppleRecordingReattachOutcome = ReattachOutcome<
  ScreenRecordingLiveHandle,
  ScreenRecordingCompletion
>;

export async function reattachAppleRecording(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    device: DeviceInfo;
    envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
    restoreSimulatorExport?(input: AppleSimulatorRecordingRestore): ScreenRecordingLiveHandle;
  }>,
): Promise<AppleRecordingReattachOutcome> {
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
async function reattachSimulatorRecording(
  params: Readonly<{
    host: AppleScreenRecordingOperationHost;
    envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
    restoreSimulatorExport?(input: AppleSimulatorRecordingRestore): ScreenRecordingLiveHandle;
  }>,
  descriptor: Extract<AppleRecordingDescriptor, { backend: 'simctl' }>,
): Promise<AppleRecordingReattachOutcome> {
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
  const restore = params.restoreSimulatorExport;
  if (
    recording === undefined ||
    restore === undefined ||
    !(await simulatorRecordingRemains(params.host, descriptor.outputPath))
  ) {
    return { status: 'missing' };
  }
  return {
    status: 'active',
    handle: restore({
      recording,
      nativePath: descriptor.outputPath,
      cleanup: async () =>
        await cleanupSimulator(params.host, descriptor.processes, params.envelope.sessionId),
    }),
  };
}

async function reattachRunnerRecording(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  descriptor: Extract<AppleRecordingDescriptor, { backend: 'runner' }>,
): Promise<AppleRecordingReattachOutcome> {
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
async function simulatorRecordingRemains(
  host: AppleScreenRecordingOperationHost,
  nativePath: string,
): Promise<boolean> {
  try {
    await host.screenRecording.finalize.sniff({ outputPath: nativePath });
    return true;
  } catch {
    return false;
  }
}

function unreattachableAppleRecording(
  reason: ResourceUnreattachableReason,
  message: string,
): AppleRecordingReattachOutcome {
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
function isWholeExportCoordinates(value: Record<string, unknown>): boolean {
  return (
    isNonemptyString(value.outPath) &&
    isFiniteNumber(value.startedAt) &&
    isRecordingScope(value.scope) &&
    typeof value.showTouches === 'boolean' &&
    typeof value.recordOnlySession === 'boolean' &&
    isOptionalText(value.clientOutPath) &&
    (value.exportQuality === undefined || isRecordingExportQuality(value.exportQuality)) &&
    isOptionalAppIdentity(value.activeSessionApp)
  );
}

function isOptionalAppIdentity(value: unknown): value is RecordingAppIdentity | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || !isNonemptyString(value.bundleId)) return false;
  return isOptionalText(value.name);
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
