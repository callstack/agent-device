import type {
  ScreenshotResultData,
  SnapshotCaptureAnnotations,
  SnapshotDiagnosticsSummary,
} from '@agent-device/contracts/capture';
import type { JsonObject } from '@agent-device/contracts/client';
import type { AppsFilter, DeviceRotation } from '@agent-device/contracts/device';
import type {
  AlertAction,
  AlertInfo,
  BackMode,
  ClickButton,
  GesturePlan,
  RepeatedInput,
  ScrollDirection,
  ResolvedScrollExecutionOptions,
  TvRemoteButton,
} from '@agent-device/contracts/interaction';
import type { RecordingExportQuality } from '@agent-device/contracts/recording';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import type {
  DeviceTarget,
  Platform,
  PlatformSelector,
  PublicPlatform,
} from '@agent-device/kernel/device';
import type {
  Point,
  Rect,
  SnapshotNode,
  SnapshotOptions,
  SnapshotState,
} from '@agent-device/kernel/snapshot';

// The backend's public leaf platform (approach b): backends distinguish iOS from
// macOS (e.g. snapshot backend routing, the macOS surface guard), so this carries the
// leaf string, not the internal collapsed `apple`.
export type AgentDeviceBackendPlatform = PublicPlatform;

export type BackendCommandContext = {
  session?: string;
  requestId?: string;
  appId?: string;
  appBundleId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type BackendSnapshotResult = {
  nodes?: SnapshotNode[];
  truncated?: boolean;
  backend?: string;
  snapshot?: SnapshotState;
  appName?: string;
  appBundleId?: string;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
} & SnapshotCaptureAnnotations;

export type BackendSnapshotOptions = SnapshotOptions & {
  includeRects?: boolean;
  includeHiddenContentHints?: boolean;
  outPath?: string;
};

export type BackendReadTextResult = {
  text: string;
};

/**
 * A backend's native text-presence reading. `found: true` is authoritative; `false` means
 * "not proven by this backend" and the caller still consults the canonical tree.
 */
export type BackendFindTextResult = {
  found: boolean;
};

export type BackendScreenshotOptions = {
  fullscreen?: boolean;
  overlayRefs?: boolean;
  pixelDensity?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
  surface?: SessionSurface;
};

export type BackendScreenshotResult = ScreenshotResultData;

export type BackendActionResult = Record<string, unknown> | void;

export type BackendDeviceOrientation = DeviceRotation;

export type BackendBackOptions = {
  mode?: BackMode;
};

export type BackendTvRemoteOptions = {
  button: TvRemoteButton;
  durationMs?: number;
};

export type BackendKeyboardOptions = {
  action: 'status' | 'get' | 'dismiss' | 'enter' | 'return';
};

export type BackendKeyboardResult = {
  platform?: Platform;
  action?: BackendKeyboardOptions['action'];
  visible?: boolean;
  inputType?: string | null;
  inputMethodPackage?: string | null;
  type?: string | null;
  wasVisible?: boolean;
  dismissed?: boolean;
  attempts?: number;
  /** iOS only: which mechanism resigned the keyboard (#1598) — 'dismissKey'
   *  (tapped the keyboard's own Hide/Dismiss/Done key); background-tap dismissal is deliberately unsupported (#1606 review). */
  mechanism?: string;
};

export type BackendClipboardTextResult = {
  text: string;
};

export type BackendAlertAction = AlertAction;

export type BackendAlertInfo = AlertInfo;

export type BackendAlertResult =
  | {
      kind: 'alertStatus';
      alert: BackendAlertInfo | null;
    }
  | {
      kind: 'alertHandled';
      handled: boolean;
      alert?: BackendAlertInfo;
      button?: string;
    }
  | {
      kind: 'alertWait';
      alert: BackendAlertInfo | null;
      waitedMs?: number;
      timedOut?: boolean;
    };

export type BackendTapOptions = RepeatedInput & {
  button?: ClickButton;
};

export type BackendRefTarget = {
  kind: 'ref';
  ref: string;
  fallbackLabel?: string;
};

export type BackendFillOptions = {
  delayMs?: number;
  /** Maestro replay compatibility: permit the runner's non-hittable coordinate path. */
  allowNonHittableCoordinateFallback?: boolean;
};

export type BackendLongPressOptions = {
  durationMs?: number;
};

export type BackendScrollTarget =
  | {
      kind: 'viewport';
    }
  | {
      kind: 'point';
      point: Point;
    };

export type BackendScrollOptions = ResolvedScrollExecutionOptions & {
  direction: ScrollDirection;
};

export type BackendOpenTarget = {
  /**
   * Generic app identifier accepted by the backend. Hosted adapters should
   * prefer structured appId, bundleId, or packageName when available.
   */
  app?: string;
  appId?: string;
  bundleId?: string;
  packageName?: string;
  /**
   * URL may be used by itself for a deep link or with an app identifier when
   * the backend supports opening a URL in a specific app context.
   */
  url?: string;
  /**
   * Platform-specific activity override, primarily for Android app launches.
   */
  activity?: string;
};

export type BackendOpenOptions = {
  launchArgs?: string[];
  relaunch?: boolean;
};

export type BackendAppListFilter = AppsFilter;

export type BackendAppInfo = {
  id: string;
  name?: string;
  bundleId?: string;
  packageName?: string;
  activity?: string;
};

export type BackendAppState = {
  appId?: string;
  bundleId?: string;
  packageName?: string;
  activity?: string;
  state?: 'unknown' | 'notRunning' | 'running' | 'foreground' | 'background';
  details?: Record<string, unknown>;
};

export type BackendPushInput =
  | {
      kind: 'json';
      payload: JsonObject;
    }
  | {
      kind: 'file';
      path: string;
    };

export type BackendAppEvent = {
  name: string;
  payload?: JsonObject;
};

export type BackendDeviceFilter = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  kind?: 'simulator' | 'emulator' | 'device' | 'desktop';
};

export type BackendDeviceInfo = {
  id: string;
  name: string;
  platform: AgentDeviceBackendPlatform;
  target?: 'mobile' | 'tv' | 'desktop';
  kind?: 'simulator' | 'emulator' | 'device' | 'desktop';
  booted?: boolean;
  details?: Record<string, unknown>;
};

export type BackendDeviceTarget = {
  id?: string;
  name?: string;
  platform?: AgentDeviceBackendPlatform;
  target?: 'mobile' | 'tv' | 'desktop';
  headless?: boolean;
};

export type BackendInstallSource =
  | {
      kind: 'path';
      path: string;
    }
  | {
      kind: 'uploadedArtifact';
      id: string;
    }
  | {
      kind: 'url';
      url: string;
    };

export type BackendInstallTarget = {
  app?: string;
  source: BackendInstallSource;
};

export type BackendInstallResult = Record<string, unknown> & {
  appId?: string;
  appName?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget?: string;
  installablePath?: string;
  archivePath?: string;
};

export type BackendRecordingOptions = {
  outPath?: string;
  fps?: number;
  quality?: RecordingExportQuality;
  showTouches?: boolean;
};

export type BackendRecordingResult = Record<string, unknown> & {
  path?: string;
  telemetryPath?: string;
  warning?: string;
};

export type BackendTraceOptions = {
  outPath?: string;
};

export type BackendTraceResult = Record<string, unknown> & {
  outPath?: string;
};

export type BackendDiagnosticsTimeWindow = {
  since?: string;
  until?: string;
};

export type BackendDiagnosticsPageOptions = BackendDiagnosticsTimeWindow & {
  cursor?: string;
  limit?: number;
};

export type BackendLogEntry = {
  timestamp?: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | string;
  message: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type BackendReadLogsOptions = BackendDiagnosticsPageOptions & {
  levels?: readonly string[];
  search?: string;
  source?: string;
};

export type BackendReadLogsResult = {
  entries: readonly BackendLogEntry[];
  nextCursor?: string;
  timeWindow?: BackendDiagnosticsTimeWindow;
  backend?: string;
  redacted?: boolean;
  notes?: readonly string[];
};

export type BackendNetworkIncludeMode = NetworkIncludeMode;

export type BackendNetworkEntry = {
  timestamp?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  metadata?: Record<string, unknown>;
};

export type BackendDumpNetworkOptions = BackendDiagnosticsPageOptions & {
  include?: BackendNetworkIncludeMode;
};

export type BackendDumpNetworkResult = {
  entries: readonly BackendNetworkEntry[];
  nextCursor?: string;
  timeWindow?: BackendDiagnosticsTimeWindow;
  backend?: string;
  redacted?: boolean;
  notes?: readonly string[];
};

export type BackendPerfMetric = {
  name: string;
  value?: number;
  unit?: string;
  status?: 'ok' | 'unavailable' | 'error';
  message?: string;
  metadata?: Record<string, unknown>;
};

export type BackendMeasurePerfOptions = BackendDiagnosticsTimeWindow & {
  sampleMs?: number;
  metrics?: readonly string[];
};

export type BackendMeasurePerfResult = {
  metrics: readonly BackendPerfMetric[];
  startedAt?: string;
  endedAt?: string;
  backend?: string;
  redacted?: boolean;
  notes?: readonly string[];
};

export type BackendShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BackendRunnerCommand = {
  command: string;
  args?: readonly string[];
  payload?: Record<string, unknown>;
};

export type BackendEscapeHatches = {
  androidShell?(
    context: BackendCommandContext,
    args: readonly string[],
  ): Promise<BackendShellResult>;
  iosRunnerCommand?(
    context: BackendCommandContext,
    command: BackendRunnerCommand,
  ): Promise<BackendActionResult>;
  macosDesktopScreenshot?(
    context: BackendCommandContext,
    outPath: string,
    options?: BackendScreenshotOptions,
  ): Promise<BackendScreenshotResult | void>;
};

export type AgentDeviceBackend = {
  platform: AgentDeviceBackendPlatform;
  escapeHatches?: BackendEscapeHatches;
  captureSnapshot?(
    context: BackendCommandContext,
    options?: BackendSnapshotOptions,
  ): Promise<BackendSnapshotResult>;
  resolveGestureViewport?(context: BackendCommandContext): Promise<Rect | undefined>;
  captureScreenshot?(
    context: BackendCommandContext,
    outPath: string,
    options?: BackendScreenshotOptions,
  ): Promise<BackendScreenshotResult | void>;
  readText?(context: BackendCommandContext, node: SnapshotNode): Promise<BackendReadTextResult>;
  /** Present only when the bound runtime advertised the conditional `findText` operation. */
  findText?(context: BackendCommandContext, text: string): Promise<BackendFindTextResult>;
  /**
   * #1542 off-screen refusal double-check: called ONLY at the moment the
   * shared off-screen interaction guard is about to REFUSE a click/tap/
   * gesture-target resolution, to re-confirm the target directly — bypassing
   * whatever bulk accessibility tree the guard's verdict came from (observed
   * on iOS: a keyboard-dismiss content-offset correction can leave a
   * ScrollView's bulk AX frame squeezed to a stale value, or the whole bulk
   * tree pinned at pre-gesture values, while the target is genuinely fine).
   *
   * Conceptually a boolean ("is this actually visible?"), but returns the
   * confirmed LIVE rect rather than a bare `true`/`false`: a rescue must tap
   * at the live coordinate, never the stale bulk-tree one the guard was
   * about to refuse — a caller that used the original rect after a rescue
   * would silently tap the wrong place when the bulk tree is stale, not just
   * stale-looking. `rootViewport` is the guard's own already-resolved root
   * viewport (Application/Window frame), passed in so an implementation can
   * validate the live rect's tap point against it without recomputing it.
   *
   * Returns `null` when the target cannot be positively confirmed on-screen
   * (no stable id/label, not found, ambiguous match, not hittable, outside
   * `rootViewport`, or any transport failure) — the guard MUST fail closed
   * (refuse) on `null`. This is a rescue path only, never a way to relax a
   * genuine refusal. Backends that do not support a direct, tree-independent
   * read simply omit this method, which leaves today's refuse-on-off-screen
   * behavior byte-for-byte unchanged.
   */
  confirmOffscreenTargetVisible?(
    context: BackendCommandContext,
    node: Pick<SnapshotNode, 'identifier' | 'label'>,
    rootViewport: Rect | null,
  ): Promise<Rect | null>;
  tap?(
    context: BackendCommandContext,
    point: Point,
    options?: BackendTapOptions,
  ): Promise<BackendActionResult>;
  tapTarget?(
    context: BackendCommandContext,
    target: BackendRefTarget,
    options?: BackendTapOptions,
  ): Promise<BackendActionResult>;
  fill?(
    context: BackendCommandContext,
    point: Point,
    text: string,
    options?: BackendFillOptions,
  ): Promise<BackendActionResult>;
  fillTarget?(
    context: BackendCommandContext,
    target: BackendRefTarget,
    text: string,
    options?: BackendFillOptions,
  ): Promise<BackendActionResult>;
  focus?(context: BackendCommandContext, point: Point): Promise<BackendActionResult>;
  longPress?(
    context: BackendCommandContext,
    point: Point,
    options?: BackendLongPressOptions,
  ): Promise<BackendActionResult>;
  hover?(context: BackendCommandContext, point: Point): Promise<BackendActionResult>;
  hoverTarget?(
    context: BackendCommandContext,
    target: BackendRefTarget,
  ): Promise<BackendActionResult>;
  scroll?(
    context: BackendCommandContext,
    target: BackendScrollTarget,
    options: BackendScrollOptions,
  ): Promise<BackendActionResult>;
  performGesture?(context: BackendCommandContext, plan: GesturePlan): Promise<BackendActionResult>;
  pressKey?(
    context: BackendCommandContext,
    key: string,
    options?: { modifiers?: string[] },
  ): Promise<BackendActionResult>;
  pressBack?(
    context: BackendCommandContext,
    options?: BackendBackOptions,
  ): Promise<BackendActionResult>;
  pressHome?(context: BackendCommandContext): Promise<BackendActionResult>;
  pressTvRemote?(
    context: BackendCommandContext,
    options: BackendTvRemoteOptions,
  ): Promise<BackendActionResult>;
  setOrientation?(
    context: BackendCommandContext,
    orientation: BackendDeviceOrientation,
  ): Promise<BackendActionResult>;
  setKeyboard?(
    context: BackendCommandContext,
    options: BackendKeyboardOptions,
  ): Promise<BackendKeyboardResult | BackendActionResult>;
  getClipboard?(context: BackendCommandContext): Promise<string | BackendClipboardTextResult>;
  setClipboard?(context: BackendCommandContext, text: string): Promise<BackendActionResult>;
  openSettings?(context: BackendCommandContext, target?: string): Promise<BackendActionResult>;
  handleAlert?(
    context: BackendCommandContext,
    action: BackendAlertAction,
    options?: { timeoutMs?: number },
  ): Promise<BackendAlertResult>;
  openAppSwitcher?(context: BackendCommandContext): Promise<BackendActionResult>;
  openApp?(
    context: BackendCommandContext,
    target: BackendOpenTarget,
    options?: BackendOpenOptions,
  ): Promise<BackendActionResult>;
  closeApp?(context: BackendCommandContext, app?: string): Promise<BackendActionResult>;
  listApps?(
    context: BackendCommandContext,
    filter: BackendAppListFilter,
  ): Promise<readonly BackendAppInfo[]>;
  getAppState?(context: BackendCommandContext, app: string): Promise<BackendAppState>;
  pushFile?(
    context: BackendCommandContext,
    input: BackendPushInput,
    target: string,
  ): Promise<BackendActionResult>;
  triggerAppEvent?(
    context: BackendCommandContext,
    event: BackendAppEvent,
  ): Promise<BackendActionResult>;
  listDevices?(
    context: BackendCommandContext,
    filter?: BackendDeviceFilter,
  ): Promise<readonly BackendDeviceInfo[]>;
  bootDevice?(
    context: BackendCommandContext,
    target?: BackendDeviceTarget,
  ): Promise<BackendActionResult>;
  shutdownDevice?(
    context: BackendCommandContext,
    target?: BackendDeviceTarget,
  ): Promise<BackendActionResult>;
  resolveInstallSource?(
    context: BackendCommandContext,
    source: BackendInstallSource,
  ): Promise<BackendInstallSource>;
  installApp?(
    context: BackendCommandContext,
    target: BackendInstallTarget,
  ): Promise<BackendInstallResult>;
  reinstallApp?(
    context: BackendCommandContext,
    target: BackendInstallTarget,
  ): Promise<BackendInstallResult>;
  startRecording?(
    context: BackendCommandContext,
    options?: BackendRecordingOptions,
  ): Promise<BackendRecordingResult>;
  stopRecording?(
    context: BackendCommandContext,
    options?: BackendRecordingOptions,
  ): Promise<BackendRecordingResult>;
  startTrace?(
    context: BackendCommandContext,
    options?: BackendTraceOptions,
  ): Promise<BackendTraceResult>;
  stopTrace?(
    context: BackendCommandContext,
    options?: BackendTraceOptions,
  ): Promise<BackendTraceResult>;
  readLogs?(
    context: BackendCommandContext,
    options?: BackendReadLogsOptions,
  ): Promise<BackendReadLogsResult>;
  dumpNetwork?(
    context: BackendCommandContext,
    options?: BackendDumpNetworkOptions,
  ): Promise<BackendDumpNetworkResult>;
  measurePerf?(
    context: BackendCommandContext,
    options?: BackendMeasurePerfOptions,
  ): Promise<BackendMeasurePerfResult>;
};
