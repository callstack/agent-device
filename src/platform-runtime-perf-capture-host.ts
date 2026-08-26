import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { CleanupOutcome, FinishOutcome } from '@agent-device/contracts/durable-resource';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import {
  PERF_CAPTURE_RESOURCE_KIND,
  type PerfNativeCaptureSnapshot,
  type PerfNativeCaptureLiveHandle,
  type PerfNativeCaptureStartInput,
  type PerfNativeCaptureStartResult,
  type PerfRuntimeOperations,
} from '@agent-device/contracts/perf-runtime';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { ManagedProcessIdentity } from '@agent-device/contracts/platform-runtime-host';
import {
  createDurableResourceEnvelope,
  decodeDurableDescriptor,
  encodeDurableDescriptor,
} from '@agent-device/capture-kit';
import { deviceIdentity, isPublicPlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  AndroidNativePerfSession,
  AndroidNativePerfStartResult,
  AndroidNativePerfStopResult,
} from './platforms/android/perf-native-types.ts';
import type { AppleXctracePerfCapture } from './platforms/apple/core/perf-xctrace.ts';
import {
  inspectManagedProcess,
  resolveManagedProcessIdentity,
  terminateManagedProcessSet,
} from './platform-runtime-screen-recording-process-host.ts';

const loadAndroidPerf = async () => await import('./platforms/android/perf-native.ts');
const loadAppleXctrace = async () => await import('./platforms/apple/core/perf-xctrace.ts');

type PerfCaptureDescriptor =
  | Readonly<{
      family: 'apple';
      marker: ManagedProcessIdentity;
      capture: Omit<AppleXctracePerfCapture, 'child' | 'wait'>;
    }>
  | Readonly<{ family: 'android'; capture: AndroidNativePerfSession }>;

const perfCaptureDescriptorCodec: DurableDescriptorCodec<
  PerfCaptureDescriptor,
  typeof PERF_CAPTURE_RESOURCE_KIND
> = Object.freeze({
  resourceKind: PERF_CAPTURE_RESOURCE_KIND,
  version: 1,
  encode: (descriptor) => descriptor,
  decode: decodePerfCaptureDescriptor,
});

export async function startApplePerfCapture(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  input: PerfNativeCaptureStartInput,
): Promise<PerfNativeCaptureStartResult> {
  if (input.kind !== 'xctrace') throw wrongNativeKind('Apple', 'xctrace', input.kind);
  const template =
    input.template ?? (input.mode === 'cpu-profile' ? 'Time Profiler' : 'Animation Hitches');
  const apple = await loadAppleXctrace();
  const capture = await apple.startAppleXctracePerfCapture({
    device,
    appBundleId: input.appId,
    mode: input.mode,
    template,
    outPath: input.outPath,
  });
  const marker = await resolveManagedProcessIdentity(capture.child.pid ?? undefined);
  if (!marker) {
    await apple.cleanupAppleXctracePerfCapture(capture).catch(() => {});
    throw new AppError('COMMAND_FAILED', 'Apple xctrace exposed no exact process identity');
  }
  return startedCaptureResult(
    device,
    owner,
    input,
    { family: 'apple', marker, capture: stripAppleCapture(capture) },
    createAppleCaptureHandle(capture),
    compactAppleCapture('started', capture),
  );
}

export async function startAndroidPerfCapture(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  input: PerfNativeCaptureStartInput,
): Promise<PerfNativeCaptureStartResult> {
  const android = await loadAndroidPerf();
  let capture: AndroidNativePerfStartResult;
  if (input.mode === 'cpu-profile') {
    if (input.kind !== 'simpleperf') throw wrongNativeKind('Android', 'simpleperf', input.kind);
    capture = await android.startAndroidSimpleperfProfile(device, input.appId, input.outPath);
  } else {
    if (input.kind !== 'perfetto') throw wrongNativeKind('Android', 'perfetto', input.kind);
    capture = await android.startAndroidPerfettoTrace(device, input.appId, input.outPath);
  }
  return startedCaptureResult(
    device,
    owner,
    input,
    { family: 'android', capture },
    createAndroidCaptureHandle(device, capture),
    compactAndroidCapture(capture),
  );
}

function startedCaptureResult(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  input: PerfNativeCaptureStartInput,
  descriptor: PerfCaptureDescriptor,
  handle: PerfNativeCaptureLiveHandle,
  response: PerfNativeCaptureSnapshot,
): PerfNativeCaptureStartResult {
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: PERF_CAPTURE_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(perfCaptureDescriptorCodec, descriptor),
    }),
    response,
  });
}

function createAppleCaptureHandle(capture: AppleXctracePerfCapture): PerfNativeCaptureLiveHandle {
  return createCaptureHandle({
    initialOutPath: capture.outPath,
    inspect: () => compactAppleCapture('started', capture),
    finish: async (outPath) =>
      await loadAppleXctrace().then(async (apple) => {
        const result = await apple.stopAppleXctracePerfCapture(capture, outPath);
        return compactAppleCapture('stopped', result);
      }),
    cleanup: async () =>
      await loadAppleXctrace().then(async (apple) => {
        await apple.cleanupAppleXctracePerfCapture(capture);
      }),
  });
}

function createAndroidCaptureHandle(
  device: DeviceInfo,
  capture: AndroidNativePerfStartResult,
): PerfNativeCaptureLiveHandle {
  return createCaptureHandle({
    initialOutPath: capture.outPath,
    inspect: () => compactAndroidCapture(capture),
    finish: async (outPath) => {
      const android = await loadAndroidPerf();
      const result =
        capture.kind === 'simpleperf'
          ? await android.stopAndroidSimpleperfProfile(device, capture, outPath)
          : await android.stopAndroidPerfettoTrace(device, capture, outPath);
      return compactAndroidCapture(result);
    },
    cleanup: async () => {
      const android = await loadAndroidPerf();
      await android.cleanupAndroidNativePerfSession(device, capture);
    },
  });
}

function createCaptureHandle(
  steps: Readonly<{
    initialOutPath: string;
    inspect(): PerfNativeCaptureSnapshot;
    finish(outPath: string): Promise<PerfNativeCaptureSnapshot>;
    cleanup(): Promise<void>;
  }>,
): PerfNativeCaptureLiveHandle {
  let outPath = steps.initialOutPath;
  let finish: Promise<FinishOutcome<PerfNativeCaptureSnapshot>> | undefined;
  let cleanup: Promise<CleanupOutcome> | undefined;
  const clean = async (): Promise<CleanupOutcome> =>
    await steps.cleanup().then(() => ({ status: 'cleaned' }) as const, cleanupPending);
  return Object.freeze({
    inspect: steps.inspect,
    setOutputPath: (value: string) => {
      outPath = value;
    },
    finish: async () =>
      (finish ??= steps
        .finish(outPath)
        .then((result) => ({ status: 'completed', result }) as const)),
    forceCleanup: async () => (cleanup ??= clean()),
    [Symbol.asyncDispose]: async () => {
      const outcome = await (cleanup ??= clean());
      assertCleanup(outcome);
    },
  });
}

export async function cleanupApplePerfCaptureDescriptor(
  envelope: Parameters<PerfRuntimeOperations['perfNativeCaptureCleanup']>[0]['envelope'],
): Promise<CleanupOutcome> {
  const decoded = decodeDurableDescriptor(envelope, perfCaptureDescriptorCodec);
  if (decoded.status !== 'decoded' || decoded.descriptor.family !== 'apple') {
    return { status: 'cleanup-pending', reason: 'manual-recovery-required' };
  }
  const ownership = await inspectManagedProcess(decoded.descriptor.marker);
  if (ownership === 'ownership-lost') {
    return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
  }
  if (ownership === 'missing') return { status: 'already-missing' };
  const stopped = await terminateManagedProcessSet([decoded.descriptor.marker]);
  if (stopped === 'terminated') return { status: 'cleaned' };
  if (stopped === 'already-missing') return { status: 'already-missing' };
  return { status: 'cleanup-pending', reason: 'ownership-fence-lost' };
}

export async function inspectApplePerfCaptureDescriptor(
  envelope: Parameters<PerfRuntimeOperations['perfNativeCaptureReattach']>[0]['envelope'],
): ReturnType<PerfRuntimeOperations['perfNativeCaptureReattach']> {
  const decoded = decodeDurableDescriptor(envelope, perfCaptureDescriptorCodec);
  if (decoded.status !== 'decoded') return decoded;
  if (decoded.descriptor.family !== 'apple') {
    return { status: 'unreattachable', reason: 'descriptor-invalid' };
  }
  const ownership = await inspectManagedProcess(decoded.descriptor.marker);
  if (ownership === 'owned-alive') {
    return { status: 'unreattachable', reason: 'transport-not-reattachable' };
  }
  if (ownership === 'ownership-lost') {
    return { status: 'unreattachable', reason: 'ownership-fence-lost' };
  }
  return { status: 'missing' };
}

export async function inspectAndroidPerfCaptureDescriptor(
  envelope: Parameters<PerfRuntimeOperations['perfNativeCaptureReattach']>[0]['envelope'],
): ReturnType<PerfRuntimeOperations['perfNativeCaptureReattach']> {
  const decoded = decodeDurableDescriptor(envelope, perfCaptureDescriptorCodec);
  if (decoded.status !== 'decoded') return decoded;
  return decoded.descriptor.family === 'android'
    ? { status: 'unreattachable', reason: 'transport-not-reattachable' }
    : { status: 'unreattachable', reason: 'descriptor-invalid' };
}

export async function cleanupAndroidPerfCaptureDescriptor(
  device: DeviceInfo,
  envelope: Parameters<PerfRuntimeOperations['perfNativeCaptureCleanup']>[0]['envelope'],
): Promise<CleanupOutcome> {
  const decoded = decodeDurableDescriptor(envelope, perfCaptureDescriptorCodec);
  if (decoded.status !== 'decoded' || decoded.descriptor.family !== 'android') {
    return { status: 'cleanup-pending', reason: 'manual-recovery-required' };
  }
  try {
    const android = await loadAndroidPerf();
    await android.cleanupAndroidNativePerfSession(device, decoded.descriptor.capture);
    return { status: 'cleaned' };
  } catch (error) {
    return cleanupPending(error);
  }
}

function stripAppleCapture(
  capture: AppleXctracePerfCapture,
): Omit<AppleXctracePerfCapture, 'child' | 'wait'> {
  const { child: _child, wait: _wait, ...descriptor } = capture;
  return descriptor;
}

function compactAppleCapture(
  state: 'started' | 'stopped',
  result: Omit<AppleXctracePerfCapture, 'child' | 'wait'> & { endedAt?: string },
): PerfNativeCaptureSnapshot {
  return {
    perf: state,
    kind: result.kind,
    mode: result.mode,
    template: result.template,
    outPath: result.outPath,
    appBundleId: result.appBundleId,
    deviceId: result.deviceId,
    platform: result.platform,
    targetPids: result.targetPids,
    targetProcesses: result.targetProcesses,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  };
}

function compactAndroidCapture(
  result: AndroidNativePerfStartResult | AndroidNativePerfStopResult,
): PerfNativeCaptureSnapshot {
  const common = {
    action: result.action,
    platform: 'android',
    type: result.type,
    packageName: result.packageName,
    appPid: result.appPid,
    profilerPid: result.profilerPid,
    state: result.state,
    startedAt: new Date(result.startedAt).toISOString(),
    stoppedAt:
      typeof result.stoppedAt === 'number' ? new Date(result.stoppedAt).toISOString() : undefined,
    outPath: result.outPath,
    sizeBytes: result.sizeBytes,
    remotePath: result.remotePath,
    method: result.method,
    message: result.message,
    ...(result.action === 'stop' ? { durationMs: result.durationMs, summary: result.summary } : {}),
  };
  return result.kind === 'simpleperf'
    ? { ...common, kind: 'simpleperf', mode: 'cpu-profile' }
    : { ...common, kind: 'perfetto', mode: 'trace' };
}

function cleanupPending(error: unknown): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'cleanup-unconfirmed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function assertCleanup(outcome: CleanupOutcome): void {
  if (outcome.status !== 'cleanup-pending') return;
  throw new AppError(
    'COMMAND_FAILED',
    outcome.message ?? 'Perf capture cleanup could not be confirmed',
    { reason: outcome.reason },
  );
}

function wrongNativeKind(platform: string, expected: string, received: string): AppError {
  return new AppError(
    'INVALID_ARGS',
    `${platform} native perf requires --kind ${expected}, not ${received}`,
  );
}

function decodePerfCaptureDescriptor(
  body: Record<string, unknown>,
): ReturnType<typeof perfCaptureDescriptorCodec.decode> {
  if (body.family === 'android' && isAndroidPerfSession(body.capture)) {
    return { status: 'decoded', descriptor: { family: 'android', capture: body.capture } };
  }
  if (
    body.family === 'apple' &&
    isApplePerfCapture(body.capture) &&
    isManagedProcessIdentity(body.marker)
  ) {
    return {
      status: 'decoded',
      descriptor: { family: 'apple', capture: body.capture, marker: body.marker },
    };
  }
  return { status: 'invalid', message: 'Perf capture descriptor body is invalid' };
}

function isAndroidPerfSession(value: unknown): value is AndroidNativePerfSession {
  if (!isRecord(value)) return false;
  return (
    isAndroidPerfKindAndType(value.kind, value.type) &&
    hasStringFields(value, ['packageName', 'appPid', 'profilerPid', 'remotePath', 'outPath']) &&
    typeof value.startedAt === 'number' &&
    isPerfCaptureState(value.state) &&
    hasOptionalNumberFields(value, ['stoppedAt', 'sizeBytes'])
  );
}

function isAndroidPerfKindAndType(kind: unknown, type: unknown): boolean {
  return (
    (kind === 'simpleperf' && type === 'cpu-profile') || (kind === 'perfetto' && type === 'trace')
  );
}

function isPerfCaptureState(value: unknown): boolean {
  return value === 'running' || value === 'stopped';
}

function isApplePerfCapture(
  value: unknown,
): value is Omit<AppleXctracePerfCapture, 'child' | 'wait'> {
  return (
    isRecord(value) &&
    value.kind === 'xctrace' &&
    (value.mode === 'cpu-profile' || value.mode === 'trace') &&
    hasStringFields(value, ['template', 'outPath', 'appBundleId', 'deviceId', 'startedAt']) &&
    isPublicPlatform(value.platform) &&
    isStringArray(value.targetProcesses) &&
    isNumberArray(value.targetPids)
  );
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function hasOptionalNumberFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => value[field] === undefined || typeof value[field] === 'number');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManagedProcessIdentity(value: unknown): value is ManagedProcessIdentity {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    typeof value.startTime === 'string' &&
    typeof value.command === 'string'
  );
}
