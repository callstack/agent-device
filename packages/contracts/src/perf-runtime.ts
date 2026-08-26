import type { PendingTransferGuard } from './async-lifecycle.ts';
import type { CleanupOutcome, LiveResourceHandle, ReattachOutcome } from './durable-resource.ts';
import type { DurableResourceEnvelope } from './durable-resource-envelope.ts';
import type { PerfKind } from './facades/observability.ts';
import type { ResourceOwnershipFence, RuntimeOperationFact } from './platform-runtime.ts';

export const PERF_CAPTURE_RESOURCE_KIND = 'perf-capture' as const;
export type PerfData = Readonly<Record<string, unknown>>;
export type PerfObservationInput = Readonly<{ appId?: string }>;
export type PerfMemorySnapshotInput = Readonly<{
  appId?: string;
  kind?: PerfKind;
  outPath?: string;
  artifactsDir: string;
}>;
export type PerfNativeCaptureMode = 'cpu-profile' | 'trace';
export type PerfNativeCaptureKind = 'xctrace' | 'simpleperf' | 'perfetto';
export type PerfNativeCaptureSnapshot = PerfData &
  (
    | Readonly<{ kind: 'xctrace'; mode: PerfNativeCaptureMode }>
    | Readonly<{ kind: 'simpleperf'; mode: 'cpu-profile' }>
    | Readonly<{ kind: 'perfetto'; mode: 'trace' }>
  );
export type PerfProfileHandoff = PerfData &
  (
    | Readonly<{
        kind: 'xctrace';
        mode: 'cpu-profile';
        outPath: string;
        template: string;
      }>
    | Readonly<{
        kind: 'simpleperf';
        mode: 'cpu-profile';
        outPath: string;
        packageName: string;
        appPid: string;
        profilerPid: string;
        remotePath: string;
        startedAt?: string;
        stoppedAt?: string;
        sizeBytes?: number;
      }>
  );
export type PerfNativeCaptureStartInput = Readonly<{
  sessionId: string;
  appId: string;
  mode: PerfNativeCaptureMode;
  kind: PerfNativeCaptureKind;
  template?: string;
  outPath: string;
  fence: ResourceOwnershipFence;
}>;
export type PerfNativeCaptureCompletion = PerfNativeCaptureSnapshot;
export type PerfNativeCaptureLiveHandle = LiveResourceHandle<PerfNativeCaptureCompletion> &
  Readonly<{
    inspect(): PerfNativeCaptureSnapshot;
    setOutputPath(outPath: string): void;
  }>;
export type PerfNativeCaptureStartResult = Readonly<{
  pendingHandle: PendingTransferGuard<PerfNativeCaptureLiveHandle>;
  envelope: DurableResourceEnvelope<typeof PERF_CAPTURE_RESOURCE_KIND>;
  response: PerfNativeCaptureSnapshot;
}>;
export type PerfNativeCaptureRecoveryInput = Readonly<{
  envelope: DurableResourceEnvelope<typeof PERF_CAPTURE_RESOURCE_KIND>;
}>;
export type PerfProfileReportInput = Readonly<{
  appId?: string;
  kind: 'xctrace' | 'simpleperf';
  tracePath: string;
  outPath: string;
  template?: string;
  profile?: PerfProfileHandoff;
}>;
export type PerfRuntimeOperations = Readonly<{
  perfFrames(input: PerfObservationInput): Promise<PerfData>;
  perfMemorySample(input: PerfObservationInput): Promise<PerfData>;
  perfMemorySnapshot(input: PerfMemorySnapshotInput): Promise<PerfData>;
  perfNativeCaptureStart(input: PerfNativeCaptureStartInput): Promise<PerfNativeCaptureStartResult>;
  perfNativeCaptureReattach(
    input: PerfNativeCaptureRecoveryInput,
  ): Promise<ReattachOutcome<PerfNativeCaptureLiveHandle, PerfNativeCaptureCompletion>>;
  perfNativeCaptureCleanup(input: PerfNativeCaptureRecoveryInput): Promise<CleanupOutcome>;
  perfProfileReport(input: PerfProfileReportInput): Promise<PerfData>;
}>;

export function perfRuntimeOperationFacts(
  cells: Readonly<{
    frames: RuntimeOperationFact;
    memorySample: RuntimeOperationFact;
    memorySnapshot: RuntimeOperationFact;
    nativeCapture: RuntimeOperationFact;
    profileReport: RuntimeOperationFact;
  }>,
): Readonly<{ [Key in keyof PerfRuntimeOperations]: RuntimeOperationFact }> {
  return Object.freeze({
    perfFrames: cells.frames,
    perfMemorySample: cells.memorySample,
    perfMemorySnapshot: cells.memorySnapshot,
    perfNativeCaptureStart: cells.nativeCapture,
    perfNativeCaptureReattach: cells.nativeCapture,
    perfNativeCaptureCleanup: cells.nativeCapture,
    perfProfileReport: cells.profileReport,
  });
}
