import type { BackMode } from '../contracts/back-mode.ts';
import type { DeviceRotation } from '../contracts/device-rotation.ts';
import type { ScrollDirection } from '../contracts/scroll-gesture.ts';
import type { TvRemoteButton } from '../contracts/tv-remote.ts';
import type { GesturePlan } from '../contracts/gesture-plan-types.ts';
import type { SettingOptions } from '../platforms/permission-utils.ts';
import type { SessionSurface } from '../contracts/session-surface.ts';
import type { BackendSnapshotResult } from '../backend.ts';
import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';
import type {
  RawSnapshotNode,
  Rect,
  SnapshotBackend,
  SnapshotOptions as BaseSnapshotOptions,
} from '../kernel/snapshot.ts';

export type RunnerContext = {
  requestId?: string;
  appBundleId?: string;
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
  runnerLeaseContext?: RunnerLogicalLeaseContext;
};

/** Subset of {@link RunnerContext} forwarded to runner command invocations. */
export type RunnerCallOptions = Pick<
  RunnerContext,
  | 'verbose'
  | 'logPath'
  | 'traceLogPath'
  | 'requestId'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
  | 'runnerLeaseContext'
>;

export type { BackMode };

export type ScreenshotOptions = {
  appBundleId?: string;
  pixelDensity?: number;
  fullscreen?: boolean;
  normalizeStatusBar?: boolean;
  stabilize?: boolean;
  surface?: SessionSurface;
  skipIosSimulatorBootCheck?: boolean;
};

export type ElementSelectorKey = 'id' | 'label' | 'text' | 'value';

export type ElementSelectorTapOptions = {
  key: ElementSelectorKey;
  value: string;
  allowNonHittableCoordinateFallback?: boolean;
};

/**
 * Legacy success text retained for compatibility when the XCTest runner used
 * the Maestro non-hittable coordinate fallback. Usage itself is carried by
 * the structured `maestroNonHittableCoordinateFallbackUsed` runner field.
 */
export const MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE = 'tapped via non-hittable coordinate fallback';

export type SnapshotOptions = BaseSnapshotOptions & {
  appBundleId?: string;
  includeRects?: boolean;
  surface?: SessionSurface;
};

export type SnapshotResult = Omit<BackendSnapshotResult, 'backend' | 'nodes'> & {
  nodes?: RawSnapshotNode[];
  backend: Extract<SnapshotBackend, 'android' | 'xctest' | 'linux-atspi' | 'web'>;
};

export type Interactor = {
  open(
    app: string,
    options?: {
      activity?: string;
      appBundleId?: string;
      launchConsole?: string;
      launchArgs?: string[];
      terminateRunningApp?: boolean;
      url?: string;
    },
  ): Promise<void>;
  openDevice(): Promise<void>;
  close(app: string): Promise<void>;
  tap(x: number, y: number): Promise<Record<string, unknown> | void>;
  tapElementSelector?(selector: ElementSelectorTapOptions): Promise<Record<string, unknown> | void>;
  doubleTap(x: number, y: number): Promise<Record<string, unknown> | void>;
  longPress(x: number, y: number, durationMs?: number): Promise<Record<string, unknown> | void>;
  focus(x: number, y: number): Promise<Record<string, unknown> | void>;
  type(text: string, delayMs?: number): Promise<void>;
  fillElementSelector?(
    selector: ElementSelectorTapOptions,
    text: string,
    delayMs?: number,
  ): Promise<Record<string, unknown> | void>;
  fill(
    x: number,
    y: number,
    text: string,
    delayMs?: number,
  ): Promise<Record<string, unknown> | void>;
  scroll(
    direction: ScrollDirection,
    options?: { amount?: number; pixels?: number; durationMs?: number },
  ): Promise<Record<string, unknown> | void>;
  screenshot(outPath: string, options?: ScreenshotOptions): Promise<void>;
  setViewport?(width: number, height: number): Promise<Record<string, unknown> | void>;
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;
  gestureViewport?(): Promise<Rect>;
  back(mode?: BackMode): Promise<void>;
  home(): Promise<void>;
  setOrientation(orientation: DeviceRotation): Promise<void>;
  performGesture?(plan: GesturePlan): Promise<Record<string, unknown> | void>;
  appSwitcher(): Promise<void>;
  tvRemote(button: TvRemoteButton, durationMs?: number): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  setSetting(
    setting: string,
    state: string,
    appId?: string,
    options?: SettingOptions,
  ): Promise<Record<string, unknown> | void>;
};
