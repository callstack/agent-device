import type { BackMode } from './back-mode.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type { TvRemoteButton } from './tv-remote.ts';
import type { GesturePlan } from './gesture-plan-types.ts';
import type { SettingOptions } from './settings.ts';
import type { SessionSurface } from './session-surface.ts';
import type { BackendSnapshotResult } from './snapshot-types.ts';
import type { RunnerLogicalLeaseContext } from './runner-lease-context.ts';
import type {
  RawSnapshotNode,
  Point,
  Rect,
  SnapshotBackend,
  SnapshotOptions as BaseSnapshotOptions,
} from '@agent-device/kernel/snapshot';

export type RunnerContext = {
  requestId?: string;
  signal?: AbortSignal;
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
  | 'signal'
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
  captureBackend?: 'runner';
};

export type ElementSelectorKey = 'id' | 'label' | 'text' | 'value';

export type ElementSelectorTapOptions = {
  key: ElementSelectorKey;
  value: string;
  allowNonHittableCoordinateFallback?: boolean;
  expectedPoint?: Point;
};

/**
 * Legacy success text retained for compatibility when the XCTest runner used
 * the Maestro non-hittable coordinate fallback. Usage itself is carried by
 * the structured `maestroNonHittableCoordinateFallbackUsed` runner field.
 */
export const MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE = 'tapped via non-hittable coordinate fallback';

export type SnapshotOptions = BaseSnapshotOptions & {
  appBundleId?: string;
  signal?: AbortSignal;
  includeRects?: boolean;
  includeHiddenContentHints?: boolean;
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
  type(text: string, delayMs?: number): Promise<Record<string, unknown> | void>;
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
    options?: { allowNonHittableCoordinateFallback?: boolean },
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
  setOrientation(orientation: DeviceRotation): Promise<{ orientation?: DeviceRotation } | void>;
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
