import { deviceIdentity, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type {
  CleanupOutcome,
  DurableDescriptorCodec,
  ManagedProcessIdentity,
  RuntimeOwnerRef,
  ScreenRecordingRuntimeHost,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import { SCREEN_RECORDING_RESOURCE_KIND } from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type AppleScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'apple' | 'finalize' | 'outputs'>;
}>;

export type AppleRecordingDescriptor =
  | Readonly<{
      backend: 'simctl';
      outputPath: string;
      processes: readonly ManagedProcessIdentity[];
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

export async function cleanupAppleRecording(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  body: Parameters<AppleRecordingDescriptorCodec['decode']>[0],
): Promise<CleanupOutcome> {
  const decoded = descriptorCodec.decode(body);
  if (decoded.status !== 'decoded' || !descriptorMatchesAppleDevice(device, decoded.descriptor)) {
    return { status: 'cleanup-pending', reason: 'manual-recovery-required' };
  }
  if (decoded.descriptor.backend === 'simctl') {
    return await cleanupSimulator(host, decoded.descriptor.processes);
  }
  return await cleanupRunner(host, device, decoded.descriptor);
}

async function cleanupSimulator(
  host: AppleScreenRecordingOperationHost,
  processes: readonly ManagedProcessIdentity[],
): Promise<CleanupOutcome> {
  const ownership = await Promise.all(
    processes.map(async (marker) => await host.screenRecording.apple.inspectProcess(marker)),
  );
  if (ownership.includes('ownership-lost')) {
    return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
  }
  if (ownership.every((value) => value === 'missing')) return { status: 'already-missing' };
  const outcomes = await Promise.all(
    processes.flatMap((marker, index) =>
      ownership[index] === 'owned-alive'
        ? [host.screenRecording.apple.terminateProcess(marker)]
        : [],
    ),
  );
  return outcomes.includes('ownership-lost')
    ? { status: 'cleanup-pending', reason: 'ownership-fence-lost' }
    : outcomes.every((outcome) => outcome === 'already-missing')
      ? { status: 'already-missing' }
      : { status: 'cleaned' };
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

export async function reattachAppleRecording(
  host: AppleScreenRecordingOperationHost,
  device: DeviceInfo,
  body: Parameters<AppleRecordingDescriptorCodec['decode']>[0],
) {
  const decoded = descriptorCodec.decode(body);
  if (decoded.status !== 'decoded') {
    return {
      status: 'unreattachable' as const,
      reason: 'descriptor-invalid' as const,
      message: decoded.message,
    };
  }
  if (!descriptorMatchesAppleDevice(device, decoded.descriptor)) {
    return {
      status: 'unreattachable' as const,
      reason: 'descriptor-invalid' as const,
      message: 'Apple screen-recording descriptor does not match the bound device.',
    };
  }
  const ownership =
    decoded.descriptor.backend === 'simctl'
      ? await Promise.all(
          decoded.descriptor.processes.map(
            async (marker) => await host.screenRecording.apple.inspectProcess(marker),
          ),
        )
      : [
          await host.screenRecording.apple.inspectRunner(
            device,
            decoded.descriptor.runnerSessionId,
            decoded.descriptor.runnerAuthority,
          ),
        ];
  if (ownership.every((value) => value === 'missing')) return { status: 'missing' as const };
  return {
    status: 'unreattachable' as const,
    reason: 'transport-not-reattachable' as const,
    message: ownership.includes('ownership-lost')
      ? 'Apple recording ownership no longer matches the durable descriptor.'
      : 'Apple screen recordings require exact cleanup after daemon restart.',
  };
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
  return processes
    ? ({
        status: 'decoded',
        descriptor: Object.freeze({ backend: 'simctl', outputPath, processes }),
      } as const)
    : invalidDescriptor();
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
