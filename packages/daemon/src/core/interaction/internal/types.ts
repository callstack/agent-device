import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonPlatformServices } from '../../platform-services.ts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { AndroidObservationAdapter } from '@agent-device/contracts/android-observation';
import type { Rect, SnapshotPreferredBackend, SnapshotState } from '@agent-device/kernel/snapshot';
import type { RequestCaptureProof } from '../../capture-disclosure.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { CommandSessionStore } from '@agent-device/contracts/runtime-contract';
import type { DeferredInteractionOutcomeMark } from '../../deferred-interaction-outcome.ts';
import type { RecordActionEntry } from '../../session-action-recorder.ts';
import type { BoundContextFromFlags } from '../../context.ts';
import type { DaemonInvokeFn, DaemonRequest } from '../../daemon-request.ts';
import type { SessionRef, SessionState } from '../../session-state.ts';
import type { BoundGestureExecutor } from '../../gesture-runtime.ts';
import type { BoundTouchExecutor } from '../../touch-runtime.ts';
import type { BoundSnapshotCapture } from '../../snapshot-runtime-binding.ts';
import type { recordTouchVisualizationEvent } from '../../recording-gestures.ts';
import type { SessionStore } from '../../session-store.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';

export type { BoundContextFromFlags } from '../../context.ts';

export type InteractionRouteInput = {
  /** Builds the command surface this request's interaction runtime executes through. */
  createCommandSurface: CreateDaemonCommandSurface;
  req: DaemonRequest;
  sessionName: string;
  logPath?: string;
  sessionStore: SessionStore;
  sessionRef?: SessionRef;
  captureSnapshotForSession?: CaptureSnapshotForSession;
  contextFromFlags: BoundContextFromFlags;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
  androidObservation?: AndroidObservationAdapter;
  /**
   * The foreground repair this request's own capture reported, when it captured at all. A coordinate
   * press consumes no capture and must not be disclosed against an earlier request's tree (#2682).
   */
  captureProof?: RequestCaptureProof;
};

/**
 * The observation capture a request admitted for itself. Only the two constructors that build an
 * observation runtime carry it — never the route input every interaction command shares — so a
 * capture reaches an observation only from the module that admitted it on the owner's facts (#3510).
 */
export type SettleObservationCaptureInput = {
  /**
   * For a route whose action runtime use carries no capture: a coordinate-targeted touch
   * (`tapPoint`/`fillPoint` declare none) or a generic-route action. Without it the post-action
   * observation reads the screen through a different producer than the caller's next command does.
   */
  settleObservationCapture?: BoundSnapshotCapture;
};

export type FindRouteInput = {
  createCommandSurface: CreateDaemonCommandSurface;
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  invoke: DaemonInvokeFn;
  inspectFacts?: InspectDeviceRuntimeFacts;
  platformServices: DaemonPlatformServices;
  bindDevice?: BindDeviceRuntime;
};

export type CaptureSnapshotForSession = (
  ref: SessionRef,
  flags: CommandFlags | undefined,
  sessionStore: SessionStore,
  contextFromFlags: BoundContextFromFlags,
  options: InteractionSnapshotOptions,
) => Promise<SnapshotState>;

export type RefSnapshotFlagGuardResponse = (
  command: 'press' | 'fill' | 'get' | 'longpress' | 'hover',
  flags: CommandFlags | undefined,
) => DaemonResponse | null;

export type InteractionSessionView = Readonly<{
  device: DeviceInfo;
  appBundleId?: string;
  trace?: SessionState['trace'];
}>;

export type InteractionSnapshotOptions = {
  interactiveOnly: boolean;
  preferredBackend?: SnapshotPreferredBackend;
  androidFreshnessMode?: 'ref-refresh';
  includeRects?: boolean;
  signal?: AbortSignal;
  boundCapture?: BoundSnapshotCapture;
};

export type InteractionCaptureOperation = (
  flags: CommandFlags | undefined,
  options: InteractionSnapshotOptions,
) => Promise<SnapshotState>;

export type InteractionRuntimeInput = {
  createCommandSurface: CreateDaemonCommandSurface;
  requestId?: string;
  flags: CommandFlags | undefined;
  session: InteractionSessionView;
  contextFromFlags: BoundContextFromFlags;
  captureSnapshot: InteractionCaptureOperation;
  runtimeSessions: CommandSessionStore;
  expireRefFrame: () => void;
  confirmOffscreenTargetVisible?: (
    node: Pick<import('@agent-device/kernel/snapshot').SnapshotNode, 'identifier' | 'label'>,
    rootViewport: Rect | null,
  ) => Promise<Rect | null>;
  pairedGestureViewport?: Rect;
  touchExecutor?: BoundTouchExecutor;
  gestures?: BoundGestureExecutor;
  /**
   * The capture every observation on this request reads the screen through: the action binding's
   * own capture when its runtime use carries one, otherwise the capture the request admitted for
   * its observations. Resolved once at construction so no route can mix producers (#3510).
   */
  boundCapture?: BoundSnapshotCapture;
};

export type InteractionGestureVisualization = (
  ...args: Parameters<typeof recordTouchVisualizationEvent> extends [SessionState, ...infer Rest]
    ? Rest
    : never
) => void;

export type InteractionFinalizationOperations = Readonly<{
  recordAction: (entry: RecordActionEntry) => void;
  markDeferredOutcome: (params: DeferredInteractionOutcomeMark) => void;
  isSessionRecording: () => boolean;
  recordGestureVisualization: InteractionGestureVisualization;
}>;
