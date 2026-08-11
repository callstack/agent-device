import type { GestureReferenceFrame, ScrollDirection } from './scroll-gesture.ts';
import type { RecordingAppIdentity } from './recording.ts';
import type { RecordingExportQuality } from './recording-export-quality.ts';
import type { RecordingScope } from './recording-scope.ts';
import type { CleanupOutcome, LiveResourceHandle, ReattachOutcome } from './durable-resource.ts';
import type { DurableResourceEnvelope } from './durable-resource-envelope.ts';
import type { PendingTransferGuard } from './async-lifecycle.ts';
import type { ResourceOwnershipFence } from './platform-runtime.ts';

export const SCREEN_RECORDING_RESOURCE_KIND = 'screen-recording' as const;

type RecordingTelemetryBase = Readonly<{
  tMs: number;
  x: number;
  y: number;
  referenceWidth?: number;
  referenceHeight?: number;
}>;

type RecordingTelemetryTravel = RecordingTelemetryBase &
  Readonly<{
    x2: number;
    y2: number;
    durationMs: number;
  }>;

/** Neutral touch-overlay event data retained by a live screen-recording handle. */
export type RecordingGestureEvent =
  | (RecordingTelemetryBase &
      Readonly<{
        kind: 'tap' | 'longpress';
        durationMs?: number;
      }>)
  | (RecordingTelemetryTravel & Readonly<{ kind: 'swipe' }>)
  | (RecordingTelemetryTravel &
      Readonly<{
        kind: 'scroll';
        contentDirection: ScrollDirection;
        amount?: number;
        pixels?: number;
      }>)
  | (RecordingTelemetryTravel & Readonly<{ kind: 'back-swipe'; edge: 'left' | 'right' }>)
  | (RecordingTelemetryBase &
      Readonly<{
        kind: 'pinch';
        scale: number;
        durationMs: number;
      }>);

export type ScreenRecordingChunk = Readonly<{
  index: number;
  path: string;
  clientOutPath?: string;
}>;

/**
 * All mutable recording state stays behind the live handle; the daemon session holds only that
 * handle plus its durable envelope.
 */
export type ScreenRecordingLiveSnapshot = Readonly<{
  backend: string;
  outPath: string;
  clientOutPath?: string;
  startedAt: number;
  scope: RecordingScope;
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: RecordingAppIdentity;
  exportQuality?: RecordingExportQuality;
  gestureEvents: readonly RecordingGestureEvent[];
  touchReferenceFrame?: GestureReferenceFrame;
  gestureClockOriginAtMs?: number;
  gestureClockOriginUptimeMs?: number;
  runnerStartedAtUptimeMs?: number;
  targetAppReadyUptimeMs?: number;
  runnerSessionId?: string;
  invalidatedReason?: string;
}>;

/** Final metadata needed to render the unchanged public recording-stop response. */
export type ScreenRecordingCompletion = Readonly<{
  backend: string;
  outPath: string;
  clientOutPath?: string;
  startedAt: number;
  completedAt: number;
  scope: RecordingScope;
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: RecordingAppIdentity;
  telemetryPath?: string;
  warning?: string;
  overlayWarning?: string;
  chunks?: readonly ScreenRecordingChunk[];
}>;

export type ScreenRecordingLiveHandle = LiveResourceHandle<ScreenRecordingCompletion> &
  Readonly<{
    inspect(): ScreenRecordingLiveSnapshot;
    appendGestureEvents(events: readonly RecordingGestureEvent[]): void;
    setTouchReferenceFrame(frame: GestureReferenceFrame | undefined): void;
    setRunnerSessionId(sessionId: string): void;
    invalidate(reason: string): void;
  }>;

export type ScreenRecordingStartInput = Readonly<{
  sessionId: string;
  outputPath: string;
  clientOutputPath?: string;
  scope: RecordingScope;
  showTouches: boolean;
  hideTouchesRequested: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: RecordingAppIdentity;
  exportQuality?: RecordingExportQuality;
  fps?: number;
  fence: ResourceOwnershipFence;
}>;

export type ScreenRecordingStartResult = Readonly<{
  pendingHandle: PendingTransferGuard<ScreenRecordingLiveHandle>;
  envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
}>;

export type ScreenRecordingReattachInput = Readonly<{
  envelope: DurableResourceEnvelope<typeof SCREEN_RECORDING_RESOURCE_KIND>;
}>;

export type ScreenRecordingRuntimeOperations = Readonly<{
  screenRecordingStart(input: ScreenRecordingStartInput): Promise<ScreenRecordingStartResult>;
  screenRecordingReattach(
    input: ScreenRecordingReattachInput,
  ): Promise<ReattachOutcome<ScreenRecordingLiveHandle, ScreenRecordingCompletion>>;
  screenRecordingCleanup(input: ScreenRecordingReattachInput): Promise<CleanupOutcome>;
}>;
