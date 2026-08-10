import type { LogBackend } from './logs.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  AppleToolHost,
  HostCommandRequest,
  HostCommandResult,
  HostCommandRunner,
  HostToolchainPreparer,
} from './platform-runtime-host.ts';
import type { ResourceOwnershipFence, RuntimeProviderMode } from './platform-runtime.ts';
import type { PendingTransferGuard } from './async-lifecycle.ts';
import {
  type CleanupOutcome,
  type LiveResourceHandle,
  type ReattachOutcome,
} from './durable-resource.ts';
import type { DurableResourceEnvelope } from './durable-resource-envelope.ts';

export const APP_LOG_RESOURCE_KIND = 'app-log' as const;

export type AppLogLiveState = 'active' | 'recovering' | 'ended' | 'failed';

type AppLogInspection = Readonly<{ backend: LogBackend }>;

type AppLogDoctorInput = Readonly<{ appBundleId?: string }>;

type AppLogDoctorResult = Readonly<{
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

type AppLogReattachInput = Readonly<{
  envelope: DurableResourceEnvelope<typeof APP_LOG_RESOURCE_KIND>;
}>;

type AppLogCleanupInput = AppLogReattachInput;

export type AppLogRuntimeOperations = Readonly<{
  appLogInspect(): Promise<AppLogInspection>;
  appLogDoctor(input: AppLogDoctorInput): Promise<AppLogDoctorResult>;
  appLogStart(input: AppLogStartInput): Promise<AppLogStartResult>;
  appLogReattach(
    input: AppLogReattachInput,
  ): Promise<ReattachOutcome<AppLogLiveHandle, AppLogCompletion>>;
  appLogCleanup(input: AppLogCleanupInput): Promise<CleanupOutcome>;
}>;

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

export type AppLogBackgroundProcess = AsyncDisposable &
  Readonly<{
    marker?: AppLogProcessMarker;
    wait: Promise<HostCommandResult>;
    terminate(): Promise<void>;
  }>;

export type AppLogProcessCommand =
  | Readonly<{
      kind: 'host';
      request: HostCommandRequest;
    }>
  | Readonly<{
      kind: 'android-adb';
      serial: string;
      args: readonly string[];
      options?: Pick<HostCommandRequest, 'allowFailure' | 'cwd' | 'env' | 'timeoutMs'>;
    }>;

export type AppLogBackgroundProcessRequest = Readonly<{
  command: AppLogProcessCommand;
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
  appleTools: AppleToolHost;
  toolchains: HostToolchainPreparer;
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
