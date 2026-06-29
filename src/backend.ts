import type { AlertAction, AlertInfo } from './alert-contract.ts';
import type { AppsFilter } from './contracts/app-inventory.ts';
import type { Point, SnapshotNode, SnapshotOptions, SnapshotState } from './kernel/snapshot.ts';
import type { NetworkIncludeMode } from './contracts.ts';
import type { DeviceTarget, Platform, PlatformSelector } from './kernel/device.ts';
import type { BackMode } from './core/back-mode.ts';
import type { RepeatedInput } from './commands/command-input.ts';
import type { ClickButton } from './core/click-button.ts';
import type { DeviceRotation } from './core/device-rotation.ts';
import type { ScrollDirection } from './core/scroll-gesture.ts';
import type { SessionSurface } from './core/session-surface.ts';
import type { RecordingExportQuality } from './core/recording-export-quality.ts';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type {
  SnapshotCaptureAnalysis,
  SnapshotCaptureAnnotations,
  SnapshotCaptureFreshness,
} from './snapshot-capture-annotations.ts';
import type { ScreenshotResultData } from './utils/screenshot-result.ts';

export type AgentDeviceBackendPlatform = Platform;

export const BACKEND_CAPABILITY_NAMES = [
  'android.shell',
  'ios.runnerCommand',
  'macos.desktopScreenshot',
] as const;

export type BackendCapabilityName = (typeof BACKEND_CAPABILITY_NAMES)[number];

export type BackendCapabilitySet = readonly BackendCapabilityName[];

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
  outPath?: string;
};

export type BackendSnapshotAnalysis = SnapshotCaptureAnalysis;

export type BackendSnapshotFreshness = SnapshotCaptureFreshness;

export type BackendReadTextResult = {
  text: string;
};

export type BackendFindTextResult = {
  found: boolean;
};

export type BackendScreenshotOptions = {
  fullscreen?: boolean;
  overlayRefs?: boolean;
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
};

export type BackendLongPressOptions = {
  durationMs?: number;
};

export type BackendSwipeOptions = {
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

export type BackendScrollOptions = {
  direction: ScrollDirection;
  amount?: number;
  pixels?: number;
  durationMs?: number;
};

export type BackendPinchOptions = {
  scale: number;
  center?: Point;
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
      payload: Record<string, unknown>;
    }
  | {
      kind: 'file';
      path: string;
    };

export type BackendAppEvent = {
  name: string;
  payload?: Record<string, unknown>;
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
  maxSize?: number;
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
  capabilities?: BackendCapabilitySet;
  escapeHatches?: BackendEscapeHatches;
  captureSnapshot?(
    context: BackendCommandContext,
    options?: BackendSnapshotOptions,
  ): Promise<BackendSnapshotResult>;
  captureScreenshot?(
    context: BackendCommandContext,
    outPath: string,
    options?: BackendScreenshotOptions,
  ): Promise<BackendScreenshotResult | void>;
  readText?(context: BackendCommandContext, node: SnapshotNode): Promise<BackendReadTextResult>;
  findText?(context: BackendCommandContext, text: string): Promise<BackendFindTextResult>;
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
  typeText?(
    context: BackendCommandContext,
    text: string,
    options?: { delayMs?: number },
  ): Promise<BackendActionResult>;
  focus?(context: BackendCommandContext, point: Point): Promise<BackendActionResult>;
  longPress?(
    context: BackendCommandContext,
    point: Point,
    options?: BackendLongPressOptions,
  ): Promise<BackendActionResult>;
  swipe?(
    context: BackendCommandContext,
    from: Point,
    to: Point,
    options?: BackendSwipeOptions,
  ): Promise<BackendActionResult>;
  scroll?(
    context: BackendCommandContext,
    target: BackendScrollTarget,
    options: BackendScrollOptions,
  ): Promise<BackendActionResult>;
  pinch?(
    context: BackendCommandContext,
    options: BackendPinchOptions,
  ): Promise<BackendActionResult>;
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
  rotate?(
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
