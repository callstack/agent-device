import type { PublicSnapshotCaptureAnnotations } from './snapshot-capture-annotations.ts';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type {
  DaemonResponseData,
  DaemonInstallSource,
  DaemonLockPolicy,
  DaemonRequest,
  DaemonResponse,
  LeaseBackend,
  NetworkIncludeMode,
  SessionIsolationMode,
  SessionRuntimeHints,
} from './contracts.ts';
import type { DeviceKind, DeviceTarget, Platform, PlatformSelector } from './kernel/device.ts';
import type { BackMode } from './core/back-mode.ts';
import type { ClickButton } from './core/click-button.ts';
import type { RecordingExportQuality } from './core/recording-export-quality.ts';
import type { DeviceRotation } from './core/device-rotation.ts';
import type {
  ScrollDirection,
  SwipePattern,
  SwipePreset,
  TransformGestureParams,
} from './core/scroll-gesture.ts';
import type { ScrollInputDirection } from './commands/interaction/runtime/gestures.ts';
import type { LogAction } from './contracts/logs.ts';
import type { SessionSurface } from './core/session-surface.ts';
import type { FindLocator } from './utils/finders.ts';
import type { SnapshotNode, SnapshotUnchanged, SnapshotVisibility } from './kernel/snapshot.ts';
import type { ScreenshotResultData } from './utils/screenshot-result.ts';
import type {
  MetroPrepareKind,
  PrepareMetroRuntimeResult,
  ReloadMetroResult,
} from './client-metro.ts';
import type { MetroBridgeScope } from './client-companion-tunnel-contract.ts';
import type { AppsFilter } from './contracts/app-inventory.ts';
import type { ScreenshotRequestFlags } from './contracts/screenshot.ts';
import type { BatchRunResult, DaemonBatchStep } from './core/batch.ts';
export type { BatchRunResult } from './core/batch.ts';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';
export type { TargetShutdownResult } from './target-shutdown-contract.ts';
import type { PerfAction, PerfArea, PerfKind, PerfSubject } from './contracts/perf.ts';
import type { AlertAction, AlertInfo } from './alert-contract.ts';
import type { DebugSymbolsOptions, DebugSymbolsResult } from './contracts/debug-symbols.ts';
import type { RemoteConnectionProfileFields } from './remote-config-schema.ts';
import type { CommandResult } from './core/command-descriptor/command-result.ts';

export type { FindLocator } from './utils/finders.ts';
export type { CompanionTunnelScope, MetroBridgeScope } from './client-companion-tunnel-contract.ts';
export type { AppsFilter } from './contracts/app-inventory.ts';
export type { AlertAction, AlertInfo, AlertPlatform, AlertSource } from './alert-contract.ts';
export type { DebugSymbolsOptions, DebugSymbolsResult } from './contracts/debug-symbols.ts';
export type { BootCommandResult, ShutdownCommandResult } from './contracts/device.ts';
export type { ViewportCommandResult } from './contracts/viewport.ts';
export type {
  AppSwitcherCommandResult,
  BackCommandResult,
  HomeCommandResult,
  RotateCommandResult,
} from './contracts/navigation.ts';
export type { ClipboardCommandResult } from './contracts/clipboard.ts';
export type { AppStateCommandResult } from './contracts/app-state.ts';
export type { KeyboardCommandResult } from './contracts/keyboard.ts';

export type AgentDeviceDaemonTransport = (
  req: Omit<DaemonRequest, 'token'>,
) => Promise<DaemonResponse>;

export type AgentDeviceClientConfig = RemoteConnectionProfileFields & {
  session?: string;
  lockPolicy?: DaemonLockPolicy;
  lockPlatform?: PlatformSelector;
  requestId?: string;
  sessionIsolation?: SessionIsolationMode;
  leaseBackend?: LeaseBackend;
  leaseTtlMs?: number;
  runtime?: SessionRuntimeHints;
  cwd?: string;
  debug?: boolean;
  cost?: boolean;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
};

export type AgentDeviceRequestOverrides = Pick<
  AgentDeviceClientConfig,
  | 'session'
  | 'lockPolicy'
  | 'lockPlatform'
  | 'requestId'
  | 'daemonBaseUrl'
  | 'daemonAuthToken'
  | 'daemonTransport'
  | 'daemonServerMode'
  | 'tenant'
  | 'sessionIsolation'
  | 'runId'
  | 'leaseId'
  | 'leaseBackend'
  | 'leaseProvider'
  | 'deviceKey'
  | 'clientId'
  | 'leaseTtlMs'
  | 'cwd'
  | 'debug'
  | 'cost'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
>;

export type AgentDeviceIdentifiers = {
  session?: string;
  deviceId?: string;
  deviceName?: string;
  udid?: string;
  serial?: string;
  appId?: string;
  appBundleId?: string;
  package?: string;
};

export type AgentDeviceSelectionOptions = {
  platform?: PlatformSelector;
  target?: DeviceTarget;
  device?: string;
  udid?: string;
  serial?: string;
  iosSimulatorDeviceSet?: string;
  androidDeviceAllowlist?: string;
};

export type AgentDeviceDevice = {
  platform: Platform;
  target: DeviceTarget;
  kind: DeviceKind;
  id: string;
  name: string;
  booted?: boolean;
  identifiers: AgentDeviceIdentifiers;
  ios?: {
    udid: string;
  };
  android?: {
    serial: string;
  };
};

export type AgentDeviceSessionDevice = {
  platform: Platform;
  target: DeviceTarget;
  id: string;
  name: string;
  identifiers: AgentDeviceIdentifiers;
  ios?: {
    udid: string;
    simulatorSetPath?: string | null;
  };
  android?: {
    serial: string;
  };
};

export type AgentDeviceSession = {
  name: string;
  createdAt: number;
  sessionStateDir?: string;
  runnerLogPath?: string;
  device: AgentDeviceSessionDevice;
  identifiers: AgentDeviceIdentifiers;
};

export type StartupPerfSample = {
  durationMs: number;
  measuredAt: string;
  method: string;
  appTarget?: string;
  appBundleId?: string;
};

export type SessionCloseResult = {
  session: string;
  shutdown?: TargetShutdownResult;
  identifiers: AgentDeviceIdentifiers;
};

export type AppInstallOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app?: string;
    appPath: string;
  };

export type AppDeployOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app: string;
    appPath: string;
  };

export type AppDeployResult = {
  app: string;
  appPath: string;
  platform: Platform;
  appId?: string;
  bundleId?: string;
  package?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type AppOpenOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    app?: string;
    url?: string;
    surface?: SessionSurface;
    activity?: string;
    launchConsole?: string;
    launchArgs?: string[];
    relaunch?: boolean;
    saveScript?: boolean | string;
    deviceHub?: boolean;
    noRecord?: boolean;
    runtime?: SessionRuntimeHints;
  };

export type AppOpenResult = {
  session: string;
  sessionStateDir?: string;
  runnerLogPath?: string;
  requestLogPath?: string;
  appName?: string;
  appBundleId?: string;
  appId?: string;
  startup?: StartupPerfSample;
  runtime?: SessionRuntimeHints;
  device?: AgentDeviceSessionDevice;
  identifiers: AgentDeviceIdentifiers;
};

export type AppCloseOptions = AgentDeviceRequestOverrides & {
  app?: string;
  shutdown?: boolean;
};

export type AppCloseResult = {
  session: string;
  closedApp?: string;
  shutdown?: TargetShutdownResult;
  identifiers: AgentDeviceIdentifiers;
};

export type AppInstallFromSourceOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    source: DaemonInstallSource;
    retainPaths?: boolean;
    retentionMs?: number;
  };

export type AppInstallFromSourceResult = {
  appName?: string;
  appId?: string;
  bundleId?: string;
  packageName?: string;
  launchTarget: string;
  installablePath?: string;
  archivePath?: string;
  materializationId?: string;
  materializationExpiresAt?: string;
  identifiers: AgentDeviceIdentifiers;
};

export type AppListOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    appsFilter?: AppsFilter;
  };

export type MaterializationReleaseOptions = AgentDeviceRequestOverrides & {
  materializationId: string;
};

export type MaterializationReleaseResult = {
  released: boolean;
  materializationId: string;
  identifiers: AgentDeviceIdentifiers;
};

export type Lease = {
  leaseId: string;
  tenantId: string;
  runId: string;
  backend: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  createdAt?: number;
  heartbeatAt?: number;
  expiresAt?: number;
};

export type LeaseOptions = AgentDeviceRequestOverrides & {
  ttlMs?: number;
};

export type LeaseAllocateOptions = LeaseOptions & {
  tenant: string;
  runId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type LeaseScopedOptions = LeaseOptions & {
  tenant?: string;
  runId?: string;
  leaseId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
};

export type MetroPrepareOptions = {
  projectRoot?: string;
  kind?: MetroPrepareKind;
  publicBaseUrl?: string;
  proxyBaseUrl?: string;
  bearerToken?: string;
  bridgeScope?: MetroBridgeScope;
  launchUrl?: string;
  companionProfileKey?: string;
  companionConsumerKey?: string;
  port?: number;
  listenHost?: string;
  statusHost?: string;
  startupTimeoutMs?: number;
  probeTimeoutMs?: number;
  reuseExisting?: boolean;
  installDependenciesIfNeeded?: boolean;
  runtimeFilePath?: string;
  logPath?: string;
};

export type MetroPrepareResult = PrepareMetroRuntimeResult;

export type MetroReloadOptions = {
  metroHost?: string;
  metroPort?: number;
  bundleUrl?: string;
  timeoutMs?: number;
};

export type MetroReloadResult = ReloadMetroResult;

export type CaptureSnapshotOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    interactiveOnly?: boolean;
    depth?: number;
    scope?: string;
    raw?: boolean;
    forceFull?: boolean;
    timeoutMs?: number;
  };

export type CaptureSnapshotResult = {
  nodes: SnapshotNode[];
  truncated: boolean;
  appName?: string;
  appBundleId?: string;
  visibility?: SnapshotVisibility;
  unchanged?: SnapshotUnchanged;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  identifiers: AgentDeviceIdentifiers;
} & PublicSnapshotCaptureAnnotations;

export type CaptureScreenshotOptions = AgentDeviceRequestOverrides & {
  path?: string;
  overlayRefs?: boolean;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
  surface?: SessionSurface;
};

export type CaptureScreenshotResult = ScreenshotResultData & {
  path: string;
  identifiers: AgentDeviceIdentifiers;
};

export type DeviceCommandBaseOptions = AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;

type WaitCommandTarget =
  | {
      durationMs: number;
      text?: never;
      ref?: never;
      selector?: never;
      timeoutMs?: never;
    }
  | (SelectorSnapshotCommandOptions & {
      text: string;
      durationMs?: never;
      ref?: never;
      selector?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      ref: string;
      durationMs?: never;
      text?: never;
      selector?: never;
      timeoutMs?: number;
    })
  | (SelectorSnapshotCommandOptions & {
      selector: string;
      durationMs?: never;
      text?: never;
      ref?: never;
      timeoutMs?: number;
    });

export type WaitCommandOptions = DeviceCommandBaseOptions & WaitCommandTarget;

export type AlertCommandOptions = DeviceCommandBaseOptions & {
  action?: AlertAction;
  timeoutMs?: number;
};

export type AppStateCommandOptions = DeviceCommandBaseOptions;

export type BackCommandOptions = DeviceCommandBaseOptions & {
  mode?: BackMode;
};

export type HomeCommandOptions = DeviceCommandBaseOptions;

export type RotateCommandOptions = DeviceCommandBaseOptions & {
  orientation: DeviceRotation;
};

export type AppSwitcherCommandOptions = DeviceCommandBaseOptions;

export type KeyboardCommandOptions = DeviceCommandBaseOptions & {
  action?: 'status' | 'dismiss' | 'enter' | 'return';
};

export type ClipboardCommandOptions =
  | (DeviceCommandBaseOptions & {
      action: 'read';
    })
  | (DeviceCommandBaseOptions & {
      action: 'write';
      text: string;
    });

export type WaitCommandResult = DaemonResponseData & {
  waitedMs?: number;
  text?: string;
  selector?: string;
};

export type AlertCommandResult = DaemonResponseData & {
  kind?: 'alertStatus' | 'alertHandled' | 'alertWait';
  action?: AlertCommandOptions['action'];
  alert?: AlertInfo | null;
  handled?: boolean;
  button?: string;
  waitedMs?: number;
  timedOut?: boolean;
  platform?: AlertInfo['platform'];
  accepted?: boolean;
  dismissed?: boolean;
  items?: string[];
};

export type ReactNativeCommandOptions = DeviceCommandBaseOptions & {
  action: 'dismiss-overlay';
};

export type PrepareCommandOptions = DeviceCommandBaseOptions & {
  action: 'ios-runner';
  timeoutMs?: number;
};

export type ViewportCommandOptions = DeviceCommandBaseOptions & {
  width: number;
  height: number;
};

export type AgentDeviceCommandClient = {
  wait: (options: WaitCommandOptions) => Promise<WaitCommandResult>;
  alert: (options?: AlertCommandOptions) => Promise<AlertCommandResult>;
  appState: (options?: AppStateCommandOptions) => Promise<CommandResult<'appstate'>>;
  back: (options?: BackCommandOptions) => Promise<CommandResult<'back'>>;
  home: (options?: HomeCommandOptions) => Promise<CommandResult<'home'>>;
  rotate: (options: RotateCommandOptions) => Promise<CommandResult<'rotate'>>;
  appSwitcher: (options?: AppSwitcherCommandOptions) => Promise<CommandResult<'app-switcher'>>;
  keyboard: (options?: KeyboardCommandOptions) => Promise<CommandResult<'keyboard'>>;
  clipboard: (options: ClipboardCommandOptions) => Promise<CommandResult<'clipboard'>>;
  reactNative: (options: ReactNativeCommandOptions) => Promise<CommandRequestResult>;
  prepare: (options: PrepareCommandOptions) => Promise<CommandRequestResult>;
  viewport: (options: ViewportCommandOptions) => Promise<CommandResult<'viewport'>>;
};

type SelectorSnapshotCommandOptions = Pick<CaptureSnapshotOptions, 'depth' | 'scope' | 'raw'>;
type FindSnapshotCommandOptions = Pick<CaptureSnapshotOptions, 'depth' | 'raw'>;

type PointTarget = {
  x: number;
  y: number;
  ref?: never;
  selector?: never;
  label?: never;
};

type RefTarget = {
  ref: string;
  label?: string;
  x?: never;
  y?: never;
  selector?: never;
};

type SelectorTarget = {
  selector: string;
  x?: never;
  y?: never;
  ref?: never;
  label?: never;
};

export type InteractionTarget = PointTarget | RefTarget | SelectorTarget;

export type ElementTarget = RefTarget | SelectorTarget;

type RepeatedPressOptions = {
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
};

export type DeviceBootOptions = DeviceCommandBaseOptions & {
  headless?: boolean;
};

export type DeviceShutdownOptions = DeviceCommandBaseOptions;

export type AppPushOptions = DeviceCommandBaseOptions & {
  app: string;
  payload: string | Record<string, unknown>;
};

export type AppTriggerEventOptions = DeviceCommandBaseOptions & {
  event: string;
  payload?: Record<string, unknown>;
};

export type CaptureDiffOptions = DeviceCommandBaseOptions &
  Pick<CaptureSnapshotOptions, 'interactiveOnly' | 'depth' | 'scope' | 'raw'> & {
    kind: 'snapshot';
    out?: string;
  };

export type ClickOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  RepeatedPressOptions & {
    button?: ClickButton;
  };

export type PressOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget &
  RepeatedPressOptions;

export type LongPressOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget & {
    durationMs?: number;
  };

export type SwipeOptions = DeviceCommandBaseOptions & {
  from: { x: number; y: number };
  to: { x: number; y: number };
  durationMs?: number;
  count?: number;
  pauseMs?: number;
  pattern?: SwipePattern;
};

export type PanOptions = DeviceCommandBaseOptions & {
  x: number;
  y: number;
  dx: number;
  dy: number;
  durationMs?: number;
};

export type FlingOptions = DeviceCommandBaseOptions & {
  direction: ScrollDirection;
  x: number;
  y: number;
  distance?: number;
  durationMs?: number;
};

export type SwipeGestureOptions = DeviceCommandBaseOptions & {
  preset: SwipePreset;
  durationMs?: number;
};

export type FocusOptions = DeviceCommandBaseOptions & {
  x: number;
  y: number;
};

export type TypeTextOptions = DeviceCommandBaseOptions & {
  text: string;
  delayMs?: number;
};

export type FillOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  InteractionTarget & {
    text: string;
    delayMs?: number;
  };

export type ScrollOptions = DeviceCommandBaseOptions & {
  direction: ScrollInputDirection;
  amount?: number;
  pixels?: number;
  durationMs?: number;
};

export type PinchOptions = DeviceCommandBaseOptions & {
  scale: number;
  x?: number;
  y?: number;
};

export type RotateGestureOptions = DeviceCommandBaseOptions & {
  degrees: number;
  x?: number;
  y?: number;
  velocity?: number;
};

export type TransformGestureOptions = DeviceCommandBaseOptions & TransformGestureParams;

export type GetOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  ElementTarget & {
    format: 'text' | 'attrs';
  };

type IsTextPredicateOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions & {
    predicate: 'text';
    selector: string;
    value: string;
  };

type IsStatePredicateOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions & {
    predicate: 'visible' | 'hidden' | 'exists' | 'editable' | 'selected';
    selector: string;
    value?: never;
  };

export type IsOptions = IsTextPredicateOptions | IsStatePredicateOptions;

type FindBaseOptions = DeviceCommandBaseOptions &
  FindSnapshotCommandOptions & {
    locator?: FindLocator;
    query: string;
    first?: boolean;
    last?: boolean;
  };

export type FindOptions =
  | (FindBaseOptions & { action?: 'click' | 'focus' | 'exists' | 'getText' | 'getAttrs' })
  | (FindBaseOptions & { action: 'wait'; timeoutMs?: number })
  | (FindBaseOptions & { action: 'fill' | 'type'; value: string });

export type ReplayRunOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    path: string;
    update?: boolean;
    /** @deprecated Use backend: 'maestro'. */
    maestro?: boolean;
    backend?: string;
    env?: string[];
    timeoutMs?: number;
  };

export type ReplayTestOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    paths: string[];
    update?: boolean;
    /** @deprecated Use backend: 'maestro'. */
    maestro?: boolean;
    backend?: string;
    env?: string[];
    failFast?: boolean;
    timeoutMs?: number;
    retries?: number;
    recordVideo?: boolean;
    artifactsDir?: string;
    /** @deprecated Use the CLI --reporter junit:<path> or --report-junit <path>. */
    reportJunit?: string;
    shardAll?: number;
    shardSplit?: number;
  };

export type BatchStep = {
  command: string;
  input: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};

export type BatchRunOptions = AgentDeviceRequestOverrides & {
  steps: BatchStep[];
  onError?: 'stop';
  maxSteps?: number;
  out?: string;
};

export type PerfOptions = DeviceCommandBaseOptions & {
  area?: PerfArea;
  subject?: PerfSubject;
  action?: PerfAction;
  kind?: PerfKind;
  template?: string;
  out?: string;
  tracePath?: string;
};

export type LogsOptions = AgentDeviceRequestOverrides & {
  action?: LogAction;
  message?: string;
  restart?: boolean;
};

export type NetworkOptions = AgentDeviceRequestOverrides & {
  action?: 'dump' | 'log';
  limit?: number;
  include?: NetworkIncludeMode;
};

export type RecordOptions = AgentDeviceRequestOverrides & {
  action: 'start' | 'stop';
  path?: string;
  fps?: number;
  maxSize?: number;
  quality?: RecordingExportQuality;
  hideTouches?: boolean;
};

export type TraceOptions = AgentDeviceRequestOverrides & {
  action: 'start' | 'stop';
  path?: string;
};

export type PermissionTarget =
  | 'camera'
  | 'microphone'
  | 'photos'
  | 'contacts'
  | 'contacts-limited'
  | 'notifications'
  | 'calendar'
  | 'location'
  | 'location-always'
  | 'media-library'
  | 'motion'
  | 'reminders'
  | 'siri'
  | 'accessibility'
  | 'screen-recording'
  | 'input-monitoring';

export type SettingsUpdateOptions =
  | (DeviceCommandBaseOptions & {
      setting: 'clear-app-state';
      state: 'clear';
      app?: string;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'wifi' | 'airplane' | 'location';
      state: 'on' | 'off';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'location';
      state: 'set';
      latitude: number;
      longitude: number;
    })
  | (DeviceCommandBaseOptions & {
      setting: 'animations';
      state: 'on' | 'off';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'appearance';
      state: 'light' | 'dark' | 'toggle';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'faceid' | 'touchid';
      state: 'match' | 'nonmatch' | 'enroll' | 'unenroll';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'fingerprint';
      state: 'match' | 'nonmatch';
    })
  | (DeviceCommandBaseOptions & {
      setting: 'permission';
      state: 'grant' | 'deny' | 'reset';
      permission: PermissionTarget;
      mode?: 'full' | 'limited';
    });

type CommandExecutionOptions = Partial<ScreenshotRequestFlags> & {
  positionals?: string[];
  kind?: string;
  out?: string;
  artifact?: string;
  dsym?: string;
  searchPath?: string;
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  forceFull?: boolean;
  count?: number;
  fps?: number;
  maxSize?: number;
  quality?: RecordingExportQuality;
  hideTouches?: boolean;
  intervalMs?: number;
  delayMs?: number;
  durationMs?: number;
  holdMs?: number;
  jitterPx?: number;
  pixels?: number;
  doubleTap?: boolean;
  clickButton?: ClickButton;
  pauseMs?: number;
  pattern?: SwipePattern;
  headless?: boolean;
  restart?: boolean;
  replayUpdate?: boolean;
  replayBackend?: string;
  replayEnv?: string[];
  replayShellEnv?: Record<string, string>;
  failFast?: boolean;
  timeoutMs?: number;
  retries?: number;
  recordVideo?: boolean;
  artifactsDir?: string;
  shardAll?: number;
  shardSplit?: number;
  findFirst?: boolean;
  findLast?: boolean;
  networkInclude?: NetworkIncludeMode;
  batchOnError?: 'stop';
  batchMaxSteps?: number;
  batchSteps?: DaemonBatchStep[];
};

export type InternalRequestOptions = AgentDeviceClientConfig &
  AgentDeviceSelectionOptions &
  CommandExecutionOptions & {
    runtime?: SessionRuntimeHints;
    overlayRefs?: boolean;
    surface?: SessionSurface;
    activity?: string;
    launchConsole?: string;
    launchArgs?: string[];
    relaunch?: boolean;
    shutdown?: boolean;
    saveScript?: boolean | string;
    deviceHub?: boolean;
    noRecord?: boolean;
    backMode?: BackMode;
    metroHost?: string;
    metroPort?: number;
    bundleUrl?: string;
    launchUrl?: string;
    appsFilter?: AppsFilter;
    installSource?: DaemonInstallSource;
    retainMaterializedPaths?: boolean;
    materializedPathRetentionMs?: number;
    materializationId?: string;
    leaseTtlMs?: number;
  };

export type CommandRequestResult = DaemonResponseData;

export type AgentDeviceClient = {
  command: AgentDeviceCommandClient;
  devices: {
    list: (
      options?: AgentDeviceRequestOverrides & AgentDeviceSelectionOptions,
    ) => Promise<AgentDeviceDevice[]>;
    boot: (options?: DeviceBootOptions) => Promise<CommandResult<'boot'>>;
    shutdown: (options?: DeviceShutdownOptions) => Promise<CommandResult<'shutdown'>>;
  };
  sessions: {
    list: (options?: AgentDeviceRequestOverrides) => Promise<AgentDeviceSession[]>;
    stateDir: (
      options?: AgentDeviceRequestOverrides & Pick<AgentDeviceClientConfig, 'stateDir'>,
    ) => Promise<string>;
    close: (
      options?: AgentDeviceRequestOverrides & { shutdown?: boolean },
    ) => Promise<SessionCloseResult>;
  };
  apps: {
    install: (options: AppInstallOptions) => Promise<AppDeployResult>;
    reinstall: (options: AppDeployOptions) => Promise<AppDeployResult>;
    installFromSource: (
      options: AppInstallFromSourceOptions,
    ) => Promise<AppInstallFromSourceResult>;
    list: (options?: AppListOptions) => Promise<string[]>;
    open: (options: AppOpenOptions) => Promise<AppOpenResult>;
    close: (options?: AppCloseOptions) => Promise<AppCloseResult>;
    push: (options: AppPushOptions) => Promise<CommandRequestResult>;
    triggerEvent: (options: AppTriggerEventOptions) => Promise<CommandRequestResult>;
  };
  materializations: {
    release: (options: MaterializationReleaseOptions) => Promise<MaterializationReleaseResult>;
  };
  leases: {
    allocate: (options: LeaseAllocateOptions) => Promise<Lease>;
    heartbeat: (options: LeaseScopedOptions) => Promise<Lease>;
    release: (options: LeaseScopedOptions) => Promise<{ released: boolean }>;
  };
  metro: {
    prepare: (options: MetroPrepareOptions) => Promise<MetroPrepareResult>;
    reload: (options?: MetroReloadOptions) => Promise<MetroReloadResult>;
  };
  capture: {
    snapshot: (options?: CaptureSnapshotOptions) => Promise<CaptureSnapshotResult>;
    screenshot: (options?: CaptureScreenshotOptions) => Promise<CaptureScreenshotResult>;
    diff: (options: CaptureDiffOptions) => Promise<CommandRequestResult>;
  };
  interactions: {
    click: (options: ClickOptions) => Promise<CommandRequestResult>;
    press: (options: PressOptions) => Promise<CommandRequestResult>;
    longPress: (options: LongPressOptions) => Promise<CommandRequestResult>;
    swipe: (options: SwipeOptions) => Promise<CommandRequestResult>;
    pan: (options: PanOptions) => Promise<CommandRequestResult>;
    fling: (options: FlingOptions) => Promise<CommandRequestResult>;
    swipeGesture: (options: SwipeGestureOptions) => Promise<CommandRequestResult>;
    focus: (options: FocusOptions) => Promise<CommandRequestResult>;
    type: (options: TypeTextOptions) => Promise<CommandRequestResult>;
    fill: (options: FillOptions) => Promise<CommandRequestResult>;
    scroll: (options: ScrollOptions) => Promise<CommandRequestResult>;
    pinch: (options: PinchOptions) => Promise<CommandRequestResult>;
    rotateGesture: (options: RotateGestureOptions) => Promise<CommandRequestResult>;
    transformGesture: (options: TransformGestureOptions) => Promise<CommandRequestResult>;
    get: (options: GetOptions) => Promise<CommandRequestResult>;
    is: (options: IsOptions) => Promise<CommandRequestResult>;
    find: (options: FindOptions) => Promise<CommandRequestResult>;
  };
  replay: {
    run: (options: ReplayRunOptions) => Promise<CommandRequestResult>;
    test: (options: ReplayTestOptions) => Promise<CommandRequestResult>;
  };
  batch: {
    run: (options: BatchRunOptions) => Promise<BatchRunResult>;
  };
  observability: {
    perf: (options?: PerfOptions) => Promise<CommandRequestResult>;
    logs: (options?: LogsOptions) => Promise<CommandRequestResult>;
    network: (options?: NetworkOptions) => Promise<CommandRequestResult>;
  };
  debug: {
    symbols: (options: DebugSymbolsOptions) => Promise<DebugSymbolsResult>;
  };
  recording: {
    record: (options: RecordOptions) => Promise<CommandRequestResult>;
    trace: (options: TraceOptions) => Promise<CommandRequestResult>;
  };
  settings: {
    update: (options: SettingsUpdateOptions) => Promise<CommandRequestResult>;
  };
};
