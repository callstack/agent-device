import type { BackMode } from './back-mode.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { ScrollDirection, TransformGestureParams } from './scroll-gesture.ts';
import type { SettingOptions } from '../platforms/permission-utils.ts';
import type { SessionSurface } from './session-surface.ts';
import type { BackendSnapshotResult } from '../backend.ts';
import type {
  RawSnapshotNode,
  SnapshotBackend,
  SnapshotOptions as BaseSnapshotOptions,
} from '../utils/snapshot.ts';

export type RunnerContext = {
  requestId?: string;
  appBundleId?: string;
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
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
>;

export type { BackMode };

export type ScreenshotOptions = {
  appBundleId?: string;
  fullscreen?: boolean;
  stabilize?: boolean;
  surface?: SessionSurface;
};

export type ElementSelectorKey = 'id' | 'label' | 'text' | 'value';

export type ElementSelectorTapOptions = {
  key: ElementSelectorKey;
  value: string;
  allowNonHittableCoordinateFallback?: boolean;
};

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
      url?: string;
    },
  ): Promise<void>;
  openDevice(): Promise<void>;
  close(app: string): Promise<void>;
  tap(x: number, y: number): Promise<Record<string, unknown> | void>;
  tapElementSelector?(selector: ElementSelectorTapOptions): Promise<Record<string, unknown> | void>;
  doubleTap(x: number, y: number): Promise<Record<string, unknown> | void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<Record<string, unknown> | void>;
  pan(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<Record<string, unknown> | void>;
  fling(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<Record<string, unknown> | void>;
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
    options?: { amount?: number; pixels?: number },
  ): Promise<Record<string, unknown> | void>;
  pinch(scale: number, x?: number, y?: number): Promise<Record<string, unknown> | void>;
  screenshot(outPath: string, options?: ScreenshotOptions): Promise<void>;
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;
  back(mode?: BackMode): Promise<void>;
  home(): Promise<void>;
  rotate(orientation: DeviceRotation): Promise<void>;
  rotateGesture(
    degrees: number,
    x?: number,
    y?: number,
    velocity?: number,
  ): Promise<Record<string, unknown> | void>;
  transformGesture(options: TransformGestureParams): Promise<Record<string, unknown> | void>;
  appSwitcher(): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  setSetting(
    setting: string,
    state: string,
    appId?: string,
    options?: SettingOptions,
  ): Promise<Record<string, unknown> | void>;
};
