/**
 * The macOS leaf of the Apple family (ADR 0034, issue #4675).
 *
 * macOS desktop automation is not a platform family: a Mac is an `apple` device whose `appleOs` is
 * `macos`. The bundled Apple owner keeps the family claim and every iOS and tvOS route. At each of
 * its macOS branches it calls the operations below, which the managed `@agent-device/macos` package
 * supplies through a leaf claim `{ kind: 'platform', family: 'apple', appleOs: 'macos' }`.
 *
 * The leaf owns both macOS app backends, the desktop surfaces, and the Swift helper. The Apple owner
 * keeps the one XCTest runner, so the leaf reaches it through {@link MacOsRunner}, a capability the
 * owner binds to one device and hands in per call.
 */

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { AppsFilter } from './app-inventory.ts';
import type {
  Interactor,
  RunnerCallOptions,
  RunnerContext,
  SnapshotResult,
} from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { ScrollExecutionOptions } from './scroll-command.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type { MacOsHelperSurface, SessionSurface } from './session-surface.ts';
import type { CaptureSnapshotInput } from './snapshot-runtime.ts';

/** The TCC services the macOS helper grants and resets. */
export type MacOsPermissionTarget = 'accessibility' | 'screen-recording' | 'input-monitoring';

/** How an app-surface action reached the app, as the helper reports it. */
export type MacOsDeliveryMechanism =
  | 'ax-press'
  | 'ax-focus'
  | 'ax-value'
  | 'ax-selected-text'
  | 'ax-confirm'
  | 'ax-scroll-bar'
  | 'ax-show-menu'
  | 'key-events';

/** What the host answered one macOS tool: its streams and its exit code. */
export type MacOsCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** How one macOS tool call runs. `kill` names a first signal for a child that must undo something. */
export type MacOsCommandOptions = Readonly<{
  cwd?: string;
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  kill?: Readonly<{ signal: 'SIGTERM'; graceMs: number }>;
}>;

/** A process the host started and left running; the caller owns its stop. */
export type MacOsBackgroundProcess = Readonly<{
  pid?: number;
  wait: Promise<Readonly<{ stdout: string; stderr: string; exitCode: number }>>;
  terminate(): Promise<void>;
}>;

export type MacOsInstalledApp = { bundleId: string; name: string; url?: string };

export type MacOsOpenOptions = { background?: boolean };

/** The host routes a request may substitute: LaunchServices, the pasteboard, and appearance. */
export type MacOsHostProvider = {
  /** `background` launches or reopens without bringing the app to the front. */
  openBundle(bundleId: string, url?: string, options?: MacOsOpenOptions): Promise<void>;
  openTarget(target: string, options?: MacOsOpenOptions): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  readDarkMode(): Promise<boolean>;
  setDarkMode(enabled: boolean): Promise<void>;
  listApps(filter: AppsFilter): Promise<MacOsInstalledApp[]>;
};

/**
 * The Apple tool routes of one request, as the Apple owner resolved them. The leaf runs every
 * command through `runCommand`, so a request that scopes its own Apple tools reaches the leaf too
 * and no command starts from the plugin's bundled copy of the host kit.
 */
export type MacOsLeafTools = Readonly<{
  runCommand(
    cmd: string,
    args: string[],
    options?: MacOsCommandOptions,
  ): Promise<MacOsCommandResult>;
  /**
   * The process table of the host these tools run on. A scoped request answers it with its own
   * executor, so a probe never pairs pids from one host with tools on another.
   */
  listProcesses(options: {
    timeoutMs: number;
  }): Promise<readonly Readonly<{ pid: number; command: string }>[]>;
  /** Starts a command the caller stops itself, with its output captured. */
  startBackground(cmd: string, args: string[]): Promise<MacOsBackgroundProcess>;
  /** The helper transport a scoped request supplies in place of the leaf's own binary. */
  helper?: Readonly<{
    run(args: string[], options?: MacOsCommandOptions): Promise<MacOsCommandResult>;
  }>;
  /** The host routes a scoped request supplies in place of the leaf's local ones. */
  host?: MacOsHostProvider;
  readPlistJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
  /** True when a request scoped the Apple tools: the helper binary is then that scope's to name. */
  scoped: boolean;
}>;

/** The macOS wire cases of the Apple XCTest runner that the leaf maps commands to. */
export type MacOsRunnerCommand =
  | Readonly<{
      command: 'desktopScroll';
      direction: ScrollDirection;
      amount?: number;
      pixels?: number;
      durationMs?: number;
      appBundleId?: string;
    }>
  | Readonly<{
      command: 'mouseClick';
      x: number;
      y: number;
      button: 'secondary' | 'middle';
      appBundleId?: string;
    }>;

/**
 * The Apple XCTest runner, bound by the Apple owner to one macOS device. It is the only way the
 * leaf reaches the runner: the owner keeps the runner's build, session, and transport.
 */
export type MacOsRunner = Readonly<{
  run(command: MacOsRunnerCommand, options?: RunnerCallOptions): Promise<Record<string, unknown>>;
}>;

export type MacOsSurfaceSnapshotOptions = Omit<
  NonNullable<CaptureSnapshotInput['options']>,
  'surface'
> & { surface: MacOsHelperSurface };

type HelperContext = { bundleId?: string; signal?: AbortSignal; env: Readonly<EnvMap> };

export type MacOsPressResult = {
  x: number;
  y: number;
  holdMs?: number;
  clicks?: number;
  doubleClick?: boolean;
  bundleId?: string;
  surface?: SessionSurface;
  mechanism?: MacOsDeliveryMechanism;
  /** The window the helper acted in, for an app-surface press. */
  windowTitle?: string;
};

/**
 * The interactor members the `native` app backend serves itself. The Apple owner assembles the
 * session's interactor from these and from its own members that never reach the runner.
 */
export type MacOsNativeAppActions = Required<
  Pick<
    Interactor,
    | 'tap'
    | 'pressPoint'
    | 'longPress'
    | 'focus'
    | 'type'
    | 'fill'
    | 'scroll'
    | 'back'
    | 'setOrientation'
  >
>;

/** Every macOS operation the Apple owner delegates, bound to one request's tools. */
export type MacOsLeafOperations = Readonly<{
  resolveApp(app: string): Promise<string>;
  /** The open target of an app device (ADR 0035): its own app, which a link alone also opens. */
  resolveAppDeviceOpenTarget(
    device: DeviceInfo,
    target: string | undefined,
  ): Promise<{ appBundleId: string; appName?: string }>;
  openApp(
    device: DeviceInfo,
    app: string,
    options?: { appBundleId?: string; url?: string },
  ): Promise<void>;
  closeApp(device: DeviceInfo, app: string, env: Readonly<EnvMap>): Promise<void>;
  listApps(filter: AppsFilter): Promise<MacOsInstalledApp[]>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  setAppearance(state: string): Promise<void>;
  frontmostApp(
    env: Readonly<EnvMap>,
  ): Promise<{ bundleId?: string; appName?: string; pid?: number }>;
  runPermissionAction(
    action: 'grant' | 'reset',
    target: MacOsPermissionTarget,
    env: Readonly<EnvMap>,
  ): Promise<{
    target: MacOsPermissionTarget;
    granted: boolean;
    requested: boolean;
    openedSettings: boolean;
    action: 'grant' | 'reset';
    message?: string;
  }>;
  runAlertAction(
    action: 'get' | 'accept' | 'dismiss',
    options: { bundleId?: string; surface?: SessionSurface; env: Readonly<EnvMap> },
  ): Promise<{
    title?: string;
    role?: string;
    buttons?: string[];
    action?: string;
    bundleId?: string;
  }>;
  readTextAtPoint(
    x: number,
    y: number,
    options: HelperContext & { surface: MacOsHelperSurface },
  ): Promise<{ text: string }>;
  press(
    x: number,
    y: number,
    options: HelperContext & {
      surface: MacOsHelperSurface;
      holdMs?: number;
      /** Independent presses, each a single click; `--count` on every platform. */
      clicks?: number;
      /** Post each press as a double-click pair; `--double-tap`. */
      doubleClick?: boolean;
      intervalMs?: number;
    },
  ): Promise<MacOsPressResult>;
  screenshot(
    outPath: string,
    options: HelperContext & { surface: MacOsHelperSurface },
  ): Promise<{ path: string; surface?: SessionSurface }>;
  captureSurfaceSnapshot(
    options: MacOsSurfaceSnapshotOptions,
    signal: AbortSignal | undefined,
    env: Readonly<EnvMap>,
  ): Promise<SnapshotResult>;
  /** Samples host system audio through the helper's ScreenCaptureKit probe. */
  startAudioProbe(options: {
    durationMs: number;
    bucketMs: number;
    statusPath: string;
    env: Readonly<EnvMap>;
  }): Promise<MacOsBackgroundProcess>;
  /**
   * The actions of the `native` app backend: helper actions, with no runner request. `base` is the
   * Apple owner's interactor, which the press of another surface goes back to.
   */
  nativeAppActions(
    base: Pick<Interactor, 'pressPoint'>,
    context: RunnerContext,
    env: Readonly<EnvMap>,
  ): Promise<MacOsNativeAppActions>;
  /** The operations the `native` app backend refuses at admission. */
  nativeBackendFacts(): Promise<Readonly<Record<string, RuntimeOperationFact>>>;
  /** The XCTest backend's desktop scroll, mapped to the runner's `desktopScroll` wire case. */
  desktopScroll(
    runner: MacOsRunner,
    context: RunnerContext,
    runnerOptions: RunnerCallOptions,
    direction: ScrollDirection,
    options?: ScrollExecutionOptions,
  ): Promise<Record<string, unknown>>;
  /** The XCTest backend's secondary and middle click, mapped to the `mouseClick` wire case. */
  alternateClick(
    runner: MacOsRunner,
    context: RunnerContext,
    runnerOptions: RunnerCallOptions,
    point: { x: number; y: number },
    button: 'secondary' | 'middle',
  ): Promise<Record<string, unknown>>;
}>;

/** What the macOS leaf's `setup(host)` registers. */
export type MacOsPlatformLeafRegistration = Readonly<{
  family: 'apple';
  appleOs: 'macos';
  /** Binds the leaf's operations to the tools the Apple owner resolved for one request. */
  bind(tools: MacOsLeafTools): MacOsLeafOperations;
}>;

/**
 * How the running process answers for the macOS leaf, installed or not. `get()` raises the typed
 * `plugin-not-installed` outcome with the install command when the package is absent, and the
 * package's own error when it failed to load.
 */
export type MacOsPlatformLeafSelection = Readonly<{
  active?: MacOsPlatformLeafRegistration;
  get(): MacOsPlatformLeafRegistration;
}>;
