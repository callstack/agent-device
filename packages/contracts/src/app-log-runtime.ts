import type { LogBackend } from './logs.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  HostCommandRequest,
  HostCommandResult,
  HostCommandRunner,
} from './platform-runtime-host.ts';
import type {
  DeviceRuntimeOwner,
  ResourceOwnershipFence,
  RuntimeProviderMode,
  RuntimeOwnerRef,
  RuntimePlatformModule,
} from './platform-runtime.ts';
import { PendingTransferGuard } from './async-lifecycle.ts';
import {
  type CleanupOutcome,
  type FinishOutcome,
  type LiveResourceHandle,
  type ReattachOutcome,
} from './durable-resource.ts';
import { decodeDurableDescriptor } from './durable-descriptor-codec.ts';
import {
  type DurableDescriptorCodec,
  type DurableResourceEnvelope,
} from './durable-resource-envelope.ts';

export const APP_LOG_RESOURCE_KIND = 'app-log' as const;

export type AppLogLiveState = 'active' | 'recovering' | 'ended' | 'failed';

export type AppLogInspection = Readonly<{ backend: LogBackend }>;

export type AppLogDoctorInput = Readonly<{ appBundleId?: string }>;

export type AppLogDoctorResult = Readonly<{
  backend: LogBackend;
  checks: Readonly<Record<string, boolean>>;
  notes: readonly string[];
}>;

export type AppLogLiveSnapshot = Readonly<{
  backend: LogBackend;
  state: AppLogLiveState;
  startedAt: number;
}>;

export type AppLogCompletion = Readonly<{
  backend: LogBackend;
  outputPath: string;
  completedAt: number;
}>;

/** Neutral session projection of a failed app-log start or live resource. */
export type AppLogFailure = Readonly<{
  backend?: LogBackend;
  code: string;
  message: string;
  hint?: string;
}>;

export type AppLogLiveHandle = LiveResourceHandle<AppLogCompletion> &
  Readonly<{
    inspect(): AppLogLiveSnapshot;
  }>;

export type AppLogLiveHandleImplementation = Readonly<{
  inspect(): AppLogLiveSnapshot;
  finish(): Promise<FinishOutcome<AppLogCompletion>>;
  forceCleanup(): Promise<CleanupOutcome>;
}>;

export type AppLogStartInput = Readonly<{
  sessionId: string;
  appBundleId: string;
  outputPath: string;
  pidPath?: string;
  fence: ResourceOwnershipFence;
}>;

export type AppLogStartResult = Readonly<{
  pendingHandle: PendingTransferGuard<AppLogLiveHandle>;
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>;
}>;

export function createAppLogStartResult(
  handle: AppLogLiveHandle,
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>,
): AppLogStartResult {
  return Object.freeze({ pendingHandle: new PendingTransferGuard(handle), envelope });
}

export type AppLogReattachInput = Readonly<{
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>;
}>;

export type AppLogCleanupInput = AppLogReattachInput;

/** Persisted recovery coordinates supplied from the decoded envelope, never from a request. */
export type AppLogRecoveryContext = Readonly<{
  sessionId: string;
  fence: ResourceOwnershipFence;
}>;

export type AppLogRuntimeOperations = Readonly<{
  appLogInspect(): Promise<AppLogInspection>;
  appLogDoctor(input: AppLogDoctorInput): Promise<AppLogDoctorResult>;
  appLogStart(input: AppLogStartInput): Promise<AppLogStartResult>;
  appLogReattach(
    input: AppLogReattachInput,
  ): Promise<ReattachOutcome<AppLogLiveHandle, AppLogCompletion>>;
  appLogCleanup(input: AppLogCleanupInput): Promise<CleanupOutcome>;
}>;

export type AppLogDescriptorCodec<Descriptor extends object> = DurableDescriptorCodec<
  Descriptor,
  typeof APP_LOG_RESOURCE_KIND
>;

export function createAppLogRecoveryOperations<Descriptor extends object>(implementation: {
  codec: AppLogDescriptorCodec<Descriptor>;
  reattach(
    descriptor: Descriptor,
    context: AppLogRecoveryContext,
  ): Promise<ReattachOutcome<AppLogLiveHandle, AppLogCompletion>>;
  cleanup(descriptor: Descriptor, context: AppLogRecoveryContext): Promise<CleanupOutcome>;
}): Pick<AppLogRuntimeOperations, 'appLogReattach' | 'appLogCleanup'> {
  return Object.freeze({
    appLogReattach: async ({ envelope }) => {
      const decoded = decodeDurableDescriptor(envelope, implementation.codec);
      if (decoded.status === 'unreattachable') return decoded;
      return await implementation.reattach(decoded.descriptor, recoveryContext(envelope));
    },
    appLogCleanup: async ({ envelope }) => {
      const decoded = decodeDurableDescriptor(envelope, implementation.codec);
      if (decoded.status === 'decoded') {
        return await implementation.cleanup(decoded.descriptor, recoveryContext(envelope));
      }
      return {
        status: 'cleanup-pending',
        reason: 'manual-recovery-required',
        message: decoded.message,
      };
    },
  });
}

function recoveryContext(
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>,
): AppLogRecoveryContext {
  return Object.freeze({ sessionId: envelope.sessionId, fence: envelope.fence });
}

export type AppLogOutputSink = AsyncDisposable &
  Readonly<{
    write(chunk: string | Uint8Array): Promise<void>;
  }>;

export type AppLogProcessMarker = Readonly<{
  pid: number;
  startTime: string;
  command: string;
}>;

export type AppLogProcessMarkerReadOutcome =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'invalid'; message: string }>
  | Readonly<{ status: 'decoded'; marker: AppLogProcessMarker }>;

export type AppLogProcessOwnership = 'missing' | 'owned-alive' | 'ownership-lost';

/** Validates a present marker without collapsing corrupt or incomplete data into absence. */
export function decodeAppLogProcessMarker(value: unknown): AppLogProcessMarkerReadOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', message: 'App-log process marker must be an object' };
  }
  const marker = value as Record<string, unknown>;
  if (!Number.isInteger(marker.pid) || Number(marker.pid) <= 0) {
    return { status: 'invalid', message: 'App-log process marker pid must be a positive integer' };
  }
  if (typeof marker.startTime !== 'string' || marker.startTime.trim().length === 0) {
    return {
      status: 'invalid',
      message: 'App-log process marker startTime must be a non-empty string',
    };
  }
  if (typeof marker.command !== 'string' || marker.command.trim().length === 0) {
    return {
      status: 'invalid',
      message: 'App-log process marker command must be a non-empty string',
    };
  }
  return {
    status: 'decoded',
    marker: Object.freeze({
      pid: Number(marker.pid),
      startTime: marker.startTime,
      command: marker.command,
    }),
  };
}

export type AppLogBackgroundProcess = AsyncDisposable &
  Readonly<{
    marker?: AppLogProcessMarker;
    wait: Promise<HostCommandResult>;
    terminate(): Promise<void>;
  }>;

export type AppLogBackgroundProcessRequest = Readonly<{
  command: HostCommandRequest;
  output: AppLogOutputSink;
  markerPath?: string;
}>;

export type AppLogProcessStart = (
  request: AppLogBackgroundProcessRequest,
  signal?: AbortSignal,
) => Promise<AppLogBackgroundProcess>;

/** Device-bound process transport selected without turning a narrow provider into a runtime owner. */
export type AppLogProcessTransport = Readonly<{
  mode: Extract<RuntimeProviderMode, 'local' | 'transport-composed'>;
  /** Absent when the selected narrow transport cannot stream app logs. */
  start?: AppLogProcessStart;
}>;

/** Canonical daemon-owned artifact paths for one durable app-log session. */
export type AppLogSessionArtifacts = Readonly<{
  outputPath: string;
  pidPath: string;
}>;

export type AppLogRuntimeHost = Readonly<{
  commands: HostCommandRunner;
  artifacts: Readonly<{
    resolveSession(sessionId: string): AppLogSessionArtifacts;
  }>;
  outputs: Readonly<{
    openAppend(path: string): Promise<AppLogOutputSink>;
    /** Reads a bounded suffix after the host has confined the path to its session root. */
    readTail(path: string, maxBytes: number): Promise<string>;
  }>;
  processTransports: Readonly<{
    resolve(device: DeviceInfo): Promise<AppLogProcessTransport>;
  }>;
  processes: Readonly<{
    start(
      request: AppLogBackgroundProcessRequest,
      signal?: AbortSignal,
    ): Promise<AppLogBackgroundProcess>;
    readMarker(path: string): Promise<AppLogProcessMarkerReadOutcome>;
    clearMarker(path: string): Promise<void>;
    inspect(marker: AppLogProcessMarker): Promise<AppLogProcessOwnership>;
    terminate(
      marker: AppLogProcessMarker,
    ): Promise<'terminated' | 'already-missing' | 'ownership-lost'>;
  }>;
  clock: Readonly<{
    now(): number;
    sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  }>;
}>;

export type AppLogRuntimePlatformModule = RuntimePlatformModule<
  AppLogRuntimeOperations,
  AppLogRuntimeHost
>;

/** Cheap provider metadata stays eager; provider mechanics load only after selection. */
export type AppLogRuntimeProviderModule = Readonly<{
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  loadRuntime(host: AppLogRuntimeHost): Promise<DeviceRuntimeOwner<AppLogRuntimeOperations>>;
}>;

export type AppLogRuntimeOwner = DeviceRuntimeOwner<AppLogRuntimeOperations>;
