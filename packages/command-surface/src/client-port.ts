// The client port the command definitions invoke: the typed Node client surface as the command
// layer calls it. Stated in terms of contracts and command-registry vocabulary only; the published
// SDK re-exports these two names from `src/client/client-types.ts` (ADR 0008).
import type {
  AgentDeviceCapabilitiesResult,
  AgentDeviceClientConfig,
  AgentDeviceDevice,
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  AgentDeviceSession,
  AlertCommandOptions,
  AppCloseOptions,
  AppCloseResult,
  AppDeployOptions,
  AppDeployResult,
  AppInstallFromSourceOptions,
  AppInstallFromSourceResult,
  AppInstallOptions,
  AppListOptions,
  AppOpenOptions,
  AppOpenResult,
  AppPushOptions,
  ActionButtonCommandOptions,
  FoldCommandOptions,
  AppStateCommandOptions,
  AppSwitcherCommandOptions,
  AppTriggerEventOptions,
  AppUninstallOptions,
  AudioOptions,
  BackCommandOptions,
  BatchRunOptions,
  CaptureDiffOptions,
  CaptureScreenshotOptions,
  CaptureScreenshotResult,
  CaptureSnapshotOptions,
  CaptureSnapshotResult,
  ClickOptions,
  ClipboardCommandOptions,
  CloudArtifactsOptions,
  CommandRequestResult,
  DeviceBootOptions,
  DeviceShutdownOptions,
  DoctorCommandOptions,
  DragOptions,
  EventsOptions,
  FillOptions,
  FindOptions,
  FlingOptions,
  FocusOptions,
  GestureOptions,
  GetOptions,
  HomeCommandOptions,
  HoverOptions,
  IsOptions,
  KeyboardCommandOptions,
  Lease,
  LeaseAllocateOptions,
  LeaseScopedOptions,
  HumanControlHold,
  HumanControlHoldOptions,
  LogsOptions,
  LongPressOptions,
  MaterializationReleaseOptions,
  MaterializationReleaseResult,
  NetworkOptions,
  OrientationCommandOptions,
  PanOptions,
  PerfOptions,
  PinchOptions,
  PrepareCommandOptions,
  PressOptions,
  ReactNativeCommandOptions,
  RecordOptions,
  ReplayRunOptions,
  ReplayTestOptions,
  RotateGestureOptions,
  ScrollOptions,
  SessionCloseResult,
  SessionSaveScriptOptions,
  SessionSaveScriptResult,
  SettingsUpdateOptions,
  SwipeGestureOptions,
  SwipeOptions,
  TelephonyCommandOptions,
  TraceOptions,
  TapGestureOptions,
  TransformGestureOptions,
  TvRemoteCommandOptions,
  HardwareButtonCommandOptions,
  TypeTextOptions,
  ViewportCommandOptions,
  WaitCommandOptions,
} from '@agent-device/contracts/client';
import type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '@agent-device/contracts/remote';

import type { BatchRunResult } from '@agent-device/command-registry/batch';

import type {
  AgentArtifactsResult,
  CloudProviderSessionResult,
  DebugSymbolsOptions,
  DebugSymbolsResult,
} from '@agent-device/contracts/observability';
import type { CommandResult } from '@agent-device/command-registry/command-result';

export type AgentDeviceCommandClient = {
  back: (options?: BackCommandOptions) => Promise<CommandResult<'back'>>;
  home: (options?: HomeCommandOptions) => Promise<CommandResult<'home'>>;
  orientation: (options: OrientationCommandOptions) => Promise<CommandResult<'orientation'>>;
  fold: (options: FoldCommandOptions) => Promise<CommandResult<'fold'>>;
  appSwitcher: (options?: AppSwitcherCommandOptions) => Promise<CommandResult<'app-switcher'>>;
  actionButton: (options?: ActionButtonCommandOptions) => Promise<CommandResult<'action-button'>>;
  tvRemote: (options: TvRemoteCommandOptions) => Promise<CommandResult<'tv-remote'>>;
  hardwareButton: (
    options: HardwareButtonCommandOptions,
  ) => Promise<CommandResult<'hardware-button'>>;
  telephony: (options: TelephonyCommandOptions) => Promise<CommandResult<'telephony'>>;
  wait: (options: WaitCommandOptions) => Promise<CommandResult<'wait'>>;
  alert: (options?: AlertCommandOptions) => Promise<CommandRequestResult>;
  appState: (options?: AppStateCommandOptions) => Promise<CommandResult<'appstate'>>;
  keyboard: (options?: KeyboardCommandOptions) => Promise<CommandResult<'keyboard'>>;
  clipboard: (options: ClipboardCommandOptions) => Promise<CommandResult<'clipboard'>>;
  reactNative: (options: ReactNativeCommandOptions) => Promise<CommandRequestResult>;
  doctor: (options?: DoctorCommandOptions) => Promise<CommandResult<'doctor'>>;
  /**
   * JSON prepare results include timing.additiveParts for additive wall-clock phases.
   * Top-level buildMs/connectMs/healthCheckMs are diagnostics and may overlap.
   */
  prepare: (options: PrepareCommandOptions) => Promise<CommandResult<'prepare'>>;
  viewport: (options: ViewportCommandOptions) => Promise<CommandResult<'viewport'>>;
};

export type AgentDeviceClient = {
  command: AgentDeviceCommandClient;
  devices: {
    list: (
      options?: AgentDeviceRequestOverrides & AgentDeviceSelectionOptions,
    ) => Promise<AgentDeviceDevice[]>;
    capabilities: (
      options?: AgentDeviceRequestOverrides & AgentDeviceSelectionOptions,
    ) => Promise<AgentDeviceCapabilitiesResult>;
    boot: (options?: DeviceBootOptions) => Promise<CommandResult<'boot'>>;
    shutdown: (options?: DeviceShutdownOptions) => Promise<CommandResult<'shutdown'>>;
  };
  sessions: {
    list: (options?: AgentDeviceRequestOverrides) => Promise<AgentDeviceSession[]>;
    stateDir: (
      options?: AgentDeviceRequestOverrides & Pick<AgentDeviceClientConfig, 'stateDir'>,
    ) => Promise<string>;
    close: (
      options?: AgentDeviceRequestOverrides & {
        shutdown?: boolean;
        saveScript?: boolean | string;
        /** #1258: overwrite an existing --save-script target instead of refusing. Alias: --overwrite. */
        force?: boolean;
      },
    ) => Promise<SessionCloseResult>;
    saveScript: (options?: SessionSaveScriptOptions) => Promise<SessionSaveScriptResult>;
    artifacts: (options?: CloudArtifactsOptions) => Promise<AgentArtifactsResult>;
  };
  apps: {
    install: (options: AppInstallOptions) => Promise<AppDeployResult>;
    reinstall: (options: AppDeployOptions) => Promise<AppDeployResult>;
    uninstall: (options: AppUninstallOptions) => Promise<CommandResult<'uninstall'>>;
    installFromSource: (
      options: AppInstallFromSourceOptions,
    ) => Promise<AppInstallFromSourceResult>;
    list: (options?: AppListOptions) => Promise<string[]>;
    open: (options: AppOpenOptions) => Promise<AppOpenResult>;
    close: (options?: AppCloseOptions) => Promise<AppCloseResult>;
    push: (options: AppPushOptions) => Promise<CommandResult<'push'>>;
    triggerEvent: (options: AppTriggerEventOptions) => Promise<CommandResult<'trigger-app-event'>>;
  };
  materializations: {
    release: (options: MaterializationReleaseOptions) => Promise<MaterializationReleaseResult>;
  };
  leases: {
    allocate: (options: LeaseAllocateOptions) => Promise<Lease>;
    heartbeat: (options: LeaseScopedOptions) => Promise<Lease>;
    release: (
      options: LeaseScopedOptions,
    ) => Promise<{ released: boolean; provider?: CloudProviderSessionResult }>;
    humanControl: {
      list: (options?: AgentDeviceRequestOverrides) => Promise<HumanControlHold[]>;
      put: (
        id: string,
        input?: HumanControlHoldOptions,
        options?: AgentDeviceRequestOverrides,
      ) => Promise<HumanControlHold>;
      remove: (id: string, options?: AgentDeviceRequestOverrides) => Promise<boolean>;
    };
  };
  metro: {
    prepare: (options: MetroPrepareOptions) => Promise<MetroPrepareResult>;
    reload: (options?: MetroReloadOptions) => Promise<MetroReloadResult>;
  };
  capture: {
    snapshot: (options?: CaptureSnapshotOptions) => Promise<CaptureSnapshotResult>;
    screenshot: (options?: CaptureScreenshotOptions) => Promise<CaptureScreenshotResult>;
    diff: (options: CaptureDiffOptions) => Promise<CommandResult<'diff'>>;
  };
  interactions: {
    gesture: (options: GestureOptions) => Promise<CommandRequestResult>;
    click: (options: ClickOptions) => Promise<CommandResult<'click'>>;
    press: (options: PressOptions) => Promise<CommandResult<'press'>>;
    longPress: (options: LongPressOptions) => Promise<CommandResult<'longpress'>>;
    hover: (options: HoverOptions) => Promise<CommandResult<'hover'>>;
    swipe: (options: SwipeOptions) => Promise<CommandRequestResult>;
    pan: (options: PanOptions) => Promise<CommandRequestResult>;
    drag: (options: DragOptions) => Promise<CommandRequestResult>;
    fling: (options: FlingOptions) => Promise<CommandRequestResult>;
    swipeGesture: (options: SwipeGestureOptions) => Promise<CommandRequestResult>;
    focus: (options: FocusOptions) => Promise<CommandRequestResult>;
    type: (options: TypeTextOptions) => Promise<CommandRequestResult>;
    fill: (options: FillOptions) => Promise<CommandResult<'fill'>>;
    scroll: (options: ScrollOptions) => Promise<CommandRequestResult>;
    pinch: (options: PinchOptions) => Promise<CommandRequestResult>;
    rotateGesture: (options: RotateGestureOptions) => Promise<CommandRequestResult>;
    transformGesture: (options: TransformGestureOptions) => Promise<CommandRequestResult>;
    tapGesture: (options: TapGestureOptions) => Promise<CommandRequestResult>;
    get: (options: GetOptions) => Promise<CommandRequestResult>;
    is: (options: IsOptions) => Promise<CommandRequestResult>;
    find: (options: FindOptions) => Promise<CommandResult<'find'>>;
  };
  replay: {
    run: (options: ReplayRunOptions) => Promise<CommandResult<'replay'>>;
    test: (options: ReplayTestOptions) => Promise<CommandResult<'test'>>;
  };
  batch: {
    run: (options: BatchRunOptions) => Promise<BatchRunResult>;
  };
  observability: {
    perf: (options: PerfOptions) => Promise<CommandRequestResult>;
    logs: (options?: LogsOptions) => Promise<CommandRequestResult>;
    events: (options?: EventsOptions) => Promise<CommandRequestResult>;
    network: (options?: NetworkOptions) => Promise<CommandRequestResult>;
    audio: (options?: AudioOptions) => Promise<CommandRequestResult>;
  };
  debug: {
    symbols: (options: DebugSymbolsOptions) => Promise<DebugSymbolsResult>;
  };
  recording: {
    record: (options: RecordOptions) => Promise<CommandResult<'record'>>;
    trace: (options: TraceOptions) => Promise<CommandResult<'trace'>>;
  };
  settings: {
    update: (options: SettingsUpdateOptions) => Promise<CommandRequestResult>;
  };
};
