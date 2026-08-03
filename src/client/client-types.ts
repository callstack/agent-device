// The published Node client surface.
//
// The VOCABULARY it is stated in terms of — connection config, the device/session views, and every
// per-command Options/Result shape — lives in the contracts/client-*.ts family files, one file per
// command/domain family. Both this module and `commands/` (the CLI and daemon command surface) are
// stated in terms of that vocabulary, and R2 forbids `commands/` importing `client/`, so a shape
// both surfaces need has to sit below both.
//
// What is still declared HERE is the `AgentDeviceClient` facade plus the shapes that are themselves
// stated in terms of a HIGHER-ranked zone: `commands/system/navigation-projection.ts` (the projected
// navigation client) and `core/` (`CommandResult`, `BatchRunResult`). Declaring those in contracts/
// would trade 28 commands->client inversions for contracts->commands and contracts->core ones — the
// foundation depending on the layers above it, which is worse. They can move once their upstream
// declarations do; see docs/dependency-graph-findings.md §0, which also explains why the facade's
// own 4 remaining inversions are a position rather than debt.
//
// The published surface is assembled in agent-device-client.ts, which re-exports BOTH homes, so no
// name became unreachable from the package entrypoint.

// The relocated vocabulary keeps its published import path through this module — a wildcard per
// family rather than 84 named re-exports, so no name is published twice under two spellings.
export type * from '@agent-device/contracts/client';

// The Metro command vocabulary answers its question in the contracts/metro.ts domain file; named
// rather than wildcarded so the daemon-side Metro shapes there stay out of the published surface.
export type {
  MetroPrepareOptions,
  MetroPrepareResult,
  MetroReloadOptions,
  MetroReloadResult,
} from '@agent-device/contracts/remote';

// Contracts/kernel types re-exported into the PUBLISHED surface: `agent-device-client.ts` picks
// these up via `export type *`, and that is their only job — every internal consumer imports
// them from the declaring module instead. Fallow therefore sees no consumer, which is exactly
// right and exactly not actionable: deleting them would remove names from the package's public
// types. Suppressed per name rather than baselined so the reason travels with the code.
// fallow-ignore-next-line unused-type
export type { TargetShutdownResult } from '@agent-device/contracts/device';
// fallow-ignore-next-line unused-type
export type { MetroBridgeScope } from './client-companion-tunnel-contract.ts';
// fallow-ignore-next-line unused-type
export type { AppsFilter } from '@agent-device/contracts/device';
// fallow-ignore-next-line unused-type
export type { AlertAction } from '@agent-device/contracts/interaction';
// fallow-ignore-next-line unused-type
export type { AppleOS } from '@agent-device/kernel/device';
// fallow-ignore-next-line unused-type
export type { JsonObject } from '@agent-device/contracts/client';
export type { BatchRunResult } from '../core/batch.ts';

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
  AppStateCommandOptions,
  AppTriggerEventOptions,
  AudioOptions,
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
  DeviceCommandBaseOptions,
  DeviceShutdownOptions,
  DoctorCommandOptions,
  DragOptions,
  EventsOptions,
  FillOptions,
  FindOptions,
  FlingOptions,
  FocusOptions,
  GetOptions,
  IsOptions,
  KeyboardCommandOptions,
  Lease,
  LeaseAllocateOptions,
  LeaseScopedOptions,
  LogsOptions,
  LongPressOptions,
  MaterializationReleaseOptions,
  MaterializationReleaseResult,
  NetworkOptions,
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
  TraceOptions,
  TransformGestureOptions,
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

import type { RotateCommandResult } from '@agent-device/contracts/interaction';

import type {
  NavigationCommandOptions,
  ProjectedNavigationCommandClient,
} from '../commands/system/navigation-projection.ts';

import type { BatchRunResult } from '../core/batch.ts';

import type {
  AgentArtifactsResult,
  CloudProviderSessionResult,
  DebugSymbolsOptions,
  DebugSymbolsResult,
} from '@agent-device/contracts/observability';
import type { CommandResult } from '../core/command-descriptor/command-result.ts';

export type { DiffSnapshotCommandResult } from '@agent-device/contracts/capture';
export type { PrepareCommandResult, PushCommandResult } from '@agent-device/contracts/command';
export type { TriggerAppEventCommandResult } from '@agent-device/contracts/device';
export type {
  /** @deprecated Renamed to `OrientationCommandResult`. Retained until the next major. */
  RotateCommandResult,
  WaitCommandResult,
} from '@agent-device/contracts/interaction';
export type {
  DebugSymbolsOptions,
  DebugSymbolsResult,
  DoctorCommandResult,
} from '@agent-device/contracts/observability';
export type { RecordingCommandResult, TraceCommandResult } from '@agent-device/contracts/recording';
export type { ReplayCommandResult, ReplaySuiteResult } from '@agent-device/contracts/replay';

export type BackCommandOptions = DeviceCommandBaseOptions & NavigationCommandOptions<'back'>;

export type OrientationCommandOptions = DeviceCommandBaseOptions &
  NavigationCommandOptions<'orientation'>;

/** @deprecated Renamed to `OrientationCommandOptions`. Retained until the next major. */
export type RotateCommandOptions = OrientationCommandOptions;

export type AppSwitcherCommandOptions = DeviceCommandBaseOptions &
  NavigationCommandOptions<'app-switcher'>;

export type TvRemoteCommandOptions = DeviceCommandBaseOptions &
  NavigationCommandOptions<'tv-remote'>;

type NonNavigationCommandClient = {
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

export type AgentDeviceCommandClient = ProjectedNavigationCommandClient<DeviceCommandBaseOptions> &
  NonNavigationCommandClient &
  DeprecatedCommandClient;

/** Renamed command methods retained for existing consumers until the next major. */
type DeprecatedCommandClient = {
  /**
   * @deprecated Renamed to `orientation`. Delegates to it and returns the legacy
   * `action: 'rotate'` response contract. Retained until the next major version.
   */
  rotate: (options: RotateCommandOptions) => Promise<RotateCommandResult>;
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
    click: (options: ClickOptions) => Promise<CommandResult<'click'>>;
    press: (options: PressOptions) => Promise<CommandResult<'press'>>;
    longPress: (options: LongPressOptions) => Promise<CommandResult<'longpress'>>;
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
    perf: (options?: PerfOptions) => Promise<CommandRequestResult>;
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
