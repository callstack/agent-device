import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RecordingExportQuality } from './recording-export-quality.ts';
import type {
  HostCommandResult,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
} from './platform-runtime-host.ts';
import type { RecordingGestureEvent } from './screen-recording-runtime.ts';

/** A long-lived native recorder process. It deliberately carries no request scope. */
export type ScreenRecordingBackgroundProcess = Readonly<{
  markers?: readonly ManagedProcessIdentity[];
  wait: Promise<HostCommandResult>;
  terminate(): Promise<void>;
}>;

/** Closed Apple runner requests used by the recording facet. */
export type AppleScreenRecordingRunnerRequest =
  | Readonly<{
      kind: 'start';
      appBundleId: string;
      outputPath: string;
      fps?: number;
    }>
  | Readonly<{
      kind: 'stop';
      appBundleId?: string;
      runnerSessionId: string;
      runnerAuthority: 'local-lease' | 'scoped-provider';
    }>;

export type AppleScreenRecordingRunnerResult = Readonly<{
  recorderStartUptimeMs?: number;
  targetAppReadyUptimeMs?: number;
  runnerSessionId?: string;
  runnerAuthority?: 'local-lease' | 'scoped-provider';
  remotePath?: string;
}>;

export type AppleScreenRecordingAvailability =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; hint: string }>;

export type AppleScreenRecordingClockAnchor = Readonly<{
  wallClockAtMs: number;
  uptimeMs: number;
}>;

export type AppleScreenRecordingHost = Readonly<{
  availability(device: DeviceInfo): Promise<AppleScreenRecordingAvailability>;
  runRunner(
    device: DeviceInfo,
    request: AppleScreenRecordingRunnerRequest,
    signal?: AbortSignal,
  ): Promise<AppleScreenRecordingRunnerResult>;
  startSimulator(
    device: DeviceInfo,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<ScreenRecordingBackgroundProcess>;
  inspectProcess(marker: ManagedProcessIdentity): Promise<ManagedProcessOwnership>;
  terminateProcess(
    marker: ManagedProcessIdentity,
  ): Promise<'terminated' | 'already-missing' | 'ownership-lost'>;
  inspectRunner(
    device: DeviceInfo,
    runnerSessionId: string,
    runnerAuthority: 'local-lease' | 'scoped-provider',
  ): Promise<ManagedProcessOwnership>;
  retrieveRunnerRecording(
    device: DeviceInfo,
    remotePath: string,
    outputPath: string,
    signal?: AbortSignal,
  ): Promise<void>;
  captureClockAnchor(
    device: DeviceInfo,
    appBundleId: string,
    signal?: AbortSignal,
  ): Promise<AppleScreenRecordingClockAnchor | undefined>;
  isRunnerBundleId(bundleId: string): Promise<boolean>;
}>;

/** Scoped Android transport; callers cannot issue arbitrary adb commands. */
export type AndroidScreenRecordingManifestReadOutcome =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'read'; contents: string }>
  | Readonly<{ status: 'unavailable'; message: string }>;

export type AndroidScreenRecordingProcessIdentity = Readonly<{
  pid: string;
  remotePath: string;
  startTime: string;
}>;

export type AndroidScreenRecordingProcessOwnership =
  | 'missing'
  | 'owned-alive'
  | 'ownership-lost'
  | 'uncertain';

export type AndroidScreenRecordingStopOutcome =
  | 'stopped'
  | 'already-missing'
  | 'ownership-lost'
  | 'uncertain';

export type AndroidScreenRecordingTransport = Readonly<{
  mode: 'local' | 'transport-composed';
  start(
    input: Readonly<{ remotePath: string; quality?: RecordingExportQuality }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ process: AndroidScreenRecordingProcessIdentity }>>;
  inspect(
    process: AndroidScreenRecordingProcessIdentity,
    signal?: AbortSignal,
  ): Promise<AndroidScreenRecordingProcessOwnership>;
  stop(
    process: AndroidScreenRecordingProcessIdentity,
    options?: Readonly<{ force?: boolean }>,
    signal?: AbortSignal,
  ): Promise<AndroidScreenRecordingStopOutcome>;
  exists(remotePath: string, signal?: AbortSignal): Promise<boolean | 'uncertain'>;
  size(remotePath: string, signal?: AbortSignal): Promise<number | undefined | 'uncertain'>;
  findRunning(
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<readonly AndroidScreenRecordingProcessIdentity[]>;
  pullPlayable(
    input: Readonly<{ remotePath: string; outputPath: string }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult & Readonly<{ playable: boolean }>>;
  remove(remotePath: string, signal?: AbortSignal): Promise<boolean>;
  manifestPathFor(remotePath: string): string;
  readManifest(
    manifestPath: string,
    signal?: AbortSignal,
  ): Promise<AndroidScreenRecordingManifestReadOutcome>;
  writeManifest(
    input: Readonly<{ manifestPath: string; contents: string }>,
    signal?: AbortSignal,
  ): Promise<void>;
  removeManifest(manifestPath: string, signal?: AbortSignal): Promise<boolean>;
}>;

export type AndroidScreenRecordingHost = Readonly<{
  resolve(device: DeviceInfo): Promise<AndroidScreenRecordingTransport>;
}>;

export type HarmonyScreenRecordingHost = Readonly<{
  start(device: DeviceInfo, fileName: string, signal?: AbortSignal): Promise<HostCommandResult>;
  stop(device: DeviceInfo, signal?: AbortSignal): Promise<HostCommandResult>;
  findMedia(
    device: DeviceInfo,
    fileName: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  stageMedia(
    device: DeviceInfo,
    input: Readonly<{ mediaUri: string; remotePath: string }>,
    signal?: AbortSignal,
  ): Promise<boolean>;
  stagedFileSize(
    device: DeviceInfo,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
  pull(
    device: DeviceInfo,
    input: Readonly<{ remotePath: string; outputPath: string }>,
    signal?: AbortSignal,
  ): Promise<HostCommandResult>;
  remove(device: DeviceInfo, remotePath: string, signal?: AbortSignal): Promise<boolean>;
  removeMedia(device: DeviceInfo, mediaUri: string, signal?: AbortSignal): Promise<boolean>;
}>;

export type WebScreenRecordingTransport = Readonly<{
  start(outputPath: string, signal?: AbortSignal): Promise<void>;
  stop(signal?: AbortSignal): Promise<void>;
}>;

export type WebScreenRecordingHost = Readonly<{
  resolve(device: DeviceInfo): Promise<WebScreenRecordingTransport | undefined>;
}>;

/** Closed post-processing authority for stable/playable validation, telemetry, trim, and overlays. */
export type ScreenRecordingFinalizer = Readonly<{
  complete(
    input: Readonly<{
      outputPath: string;
      showTouches: boolean;
      gestureEvents: readonly RecordingGestureEvent[];
      exportQuality?: RecordingExportQuality;
      trimStartMs?: number;
      targetLabel: string;
    }>,
    signal?: AbortSignal,
  ): Promise<Readonly<{ telemetryPath?: string; warning?: string; overlayWarning?: string }>>;
}>;

/** Destructive output preparation occurs only after package-owned semantic validation. */
export type ScreenRecordingOutputHost = Readonly<{
  prepare(outputPath: string): Promise<void>;
}>;

/** Focused host authorities consumed only by package-owned screen-recording mechanics. */
export type ScreenRecordingRuntimeHost = Readonly<{
  apple: AppleScreenRecordingHost;
  android: AndroidScreenRecordingHost;
  harmony: HarmonyScreenRecordingHost;
  web: WebScreenRecordingHost;
  outputs: ScreenRecordingOutputHost;
  finalize: ScreenRecordingFinalizer;
}>;
