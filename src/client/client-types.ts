// The published Node client surface.
//
// The VOCABULARY it is stated in terms of — connection config, the device/session views, and every
// per-command Options/Result shape — lives in contracts/client-api.ts, below both this zone and
// `commands/`. R2 forbids the reverse import, so a shape both surfaces need has to sit below both.
//
// What is still declared HERE is the `AgentDeviceClient` facade plus the shapes that are themselves
// stated in terms of a HIGHER-ranked zone — `commands/` (navigation projection, ScrollInputDirection)
// and `metro/` (prepare/reload results). Declaring those in contracts/ would trade 28
// commands->client inversions for contracts->commands and contracts->metro ones: the foundation
// depending on the layers above it, which is worse. They can move once their upstream declarations
// do — see docs/dependency-graph-findings.md.
//
// The published surface is assembled in agent-device-client.ts, which re-exports BOTH homes, so no
// name became unreachable from the package entrypoint.

// The relocated vocabulary keeps its published import path through this module: one wildcard
// rather than 84 named re-exports, so no name is published twice under two spellings.
export type * from '../contracts/client-api.ts';

// Contracts/kernel types re-exported into the PUBLISHED surface: `agent-device-client.ts` picks
// these up via `export type *`, and that is their only job — every internal consumer imports
// them from the declaring module instead. Fallow therefore sees no consumer, which is exactly
// right and exactly not actionable: deleting them would remove names from the package's public
// types. Suppressed per name rather than baselined so the reason travels with the code.
// fallow-ignore-next-line unused-type
export type { TargetShutdownResult } from '../contracts/target-shutdown-contract.ts';
// fallow-ignore-next-line unused-type
export type { MetroBridgeScope } from './client-companion-tunnel-contract.ts';
// fallow-ignore-next-line unused-type
export type { AppsFilter } from '../contracts/app-inventory.ts';
// fallow-ignore-next-line unused-type
export type { AlertAction } from '../contracts/alert-contract.ts';
// fallow-ignore-next-line unused-type
export type { AppleOS } from '../kernel/device.ts';
// fallow-ignore-next-line unused-type
export type { JsonObject } from '../contracts/json.ts';

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
  MetroPrepareOptions,
  MetroReloadOptions,
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
} from '../contracts/client-api.ts';

import type { RotateCommandResult } from '../contracts/navigation.ts';

import type { ScrollInputDirection } from '../commands/interaction/runtime/gestures.ts';
import type {
  NavigationCommandOptions,
  ProjectedNavigationCommandClient,
} from '../commands/system/navigation-projection.ts';

import type { PrepareMetroRuntimeResult, ReloadMetroResult } from '../metro/client-metro.ts';

import type { BatchRunResult } from '../core/batch.ts';
export type { BatchRunResult } from '../core/batch.ts';

import type { DebugSymbolsOptions, DebugSymbolsResult } from '../contracts/debug-symbols.ts';

import type { CommandResult } from '../core/command-descriptor/command-result.ts';
import type {
  AgentArtifactsResult,
  CloudProviderSessionResult,
} from '../contracts/cloud-artifacts.ts';

export type { DebugSymbolsOptions, DebugSymbolsResult } from '../contracts/debug-symbols.ts';
export type {
  /** @deprecated Renamed to `OrientationCommandResult`. Retained until the next major. */
  RotateCommandResult,
} from '../contracts/navigation.ts';
export type { WaitCommandResult } from '../contracts/wait.ts';
export type { PrepareCommandResult } from '../contracts/prepare.ts';
export type { PushCommandResult } from '../contracts/push.ts';
export type { TriggerAppEventCommandResult } from '../contracts/app-events.ts';
export type { DoctorCommandResult } from '../contracts/doctor.ts';
export type { DiffSnapshotCommandResult } from '../contracts/diff.ts';
export type { RecordingCommandResult, TraceCommandResult } from '../contracts/recording.ts';
export type { ReplayCommandResult, ReplaySuiteResult } from '../contracts/replay.ts';

export type MetroPrepareResult = PrepareMetroRuntimeResult;

export type MetroReloadResult = ReloadMetroResult;

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

/**
 * Opt-in (#1101): after the action, wait for the UI to go quiet and return the
 * settled diff vs the pre-action tree (`settle` on the result) in the same
 * response. Best-effort — never fails the action. `settleQuietMs` tunes the
 * quiet window (default 500ms); `timeoutMs` bounds the settle wait (default
 * 10s) when `settle` is true. A bare `timeoutMs` without `settle` is ignored
 * for compatibility; `settleQuietMs` still requires `settle`.
 */

export type ScrollOptions = DeviceCommandBaseOptions & {
  direction: ScrollInputDirection;
  amount?: number;
  pixels?: number;
  durationMs?: number;
};

/**
 * #1271 stage 2 (ADR 0012 amendment): `get`/`is`/`find` are observation-only
 * and excluded from a repair-armed heal by default. `record` forces this
 * action through (the corrective-read case); `noRecord` continues to opt the
 * action out entirely. Mutually exclusive.
 */

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
