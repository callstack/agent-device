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

/**
 * The channel the XCTest runner actually entered text through — the Swift
 * `TextEntryResult.textEntryRoute` (RunnerTests+TextTyping.swift,
 * RunnerTests+SynthesizedTextEntry.swift). Closed set, because the runner is
 * its only producer and the boundary that narrows it
 * (readTypeTextBackendResult, src/platforms/apple/interactions.ts) drops a
 * route it cannot name — so a Swift-side addition would silently vanish. The
 * route-parity test in src/platforms/apple/core/__tests__/interactions.test.ts
 * reads the Swift sources and fails instead.
 */
export const TEXT_ENTRY_ROUTES = [
  'xctest-element',
  'synthesized-first-responder',
  'synthesized-first-responder-replacement',
  'xctest-application-fallback',
] as const;

export type TextEntryRoute = (typeof TEXT_ENTRY_ROUTES)[number];

/**
 * What `Interactor.type` reports back about the entry it performed. Only the
 * Apple runner populates it; every other platform types blind and returns void.
 */
export type TypeTextBackendResult = {
  textEntryRoute?: TextEntryRoute;
};

/**
 * What a cloud-WebDriver `fill` could establish about its target taking text
 * entry focus before it sent the keys (#1658). The local Apple runner owns this
 * discipline in Swift and reports it as a `textEntryRoute`; the cloud path has
 * no runner, only what the driver will tell it, so it names what it observed
 * instead of which channel it typed through. Listed strongest evidence first:
 *
 * - `focused-element`: the element holding text-entry focus after the tap
 *   contains the tapped point — positive evidence that THIS field, not merely
 *   some field, took focus.
 * - `keyboard-shown`: no active-element route, but the software keyboard went
 *   from hidden to shown after our tap. Witnesses that focus arrived somewhere,
 *   which only means our field when the keyboard was down beforehand.
 * Every value describes a fill that sent its keys AND witnessed focus first.
 * There is deliberately no value for "typed without evidence": nothing renders
 * this field, so such a value would reach a caller as an ordinary success and
 * recreate the #1658 silent false success it exists to remove. Every
 * unwitnessed case throws without typing instead —
 *
 * - `text_entry_focus_not_observed`: the tap focused nothing, or a keyboard
 *   already up on a driver that cannot say which field owns it (keys would have
 *   landed in the PREVIOUS field).
 * - `text_entry_focus_unobservable`: the driver implements neither route, so no
 *   wait could establish anything. `press` + `type` remains the deliberate way
 *   to enter text unwitnessed.
 *
 * Closed set: the cloud interactor is its only producer and the boundary that
 * narrows it (readFillBackendResult, src/core/dispatch-interactions.ts) drops a
 * value it cannot name.
 */
export const CLOUD_TEXT_ENTRY_READINESS = ['focused-element', 'keyboard-shown'] as const;

export type CloudTextEntryReadiness = (typeof CLOUD_TEXT_ENTRY_READINESS)[number];

export type FillVerificationTarget = {
  resourceId: string | null;
  className: string | null;
  packageName: string | null;
  rect: Rect;
};

export type FillUnconfirmedVerification = {
  verification: 'unconfirmed';
  requested: string;
  before: string | null;
  after: string | null;
  target: FillVerificationTarget;
};

/**
 * What `Interactor.fill` reports back about the entry it performed. The
 * cloud-WebDriver interactor populates `textEntryReadiness`; Android may return
 * target-bound `verification: 'unconfirmed'` evidence when an app-owned field
 * changed but formatting prevented raw equality. The Apple runner carries its
 * own readiness equivalent in Swift.
 */
export type FillBackendResult =
  | {
      textEntryReadiness?: CloudTextEntryReadiness;
      verification?: never;
    }
  | ({ textEntryReadiness?: CloudTextEntryReadiness } & FillUnconfirmedVerification);

export type SnapshotOptions = BaseSnapshotOptions & {
  appBundleId?: string;
  signal?: AbortSignal;
  includeRects?: boolean;
  includeHiddenContentHints?: boolean;
  surface?: SessionSurface;
};

export type SnapshotResult = Omit<BackendSnapshotResult, 'backend' | 'nodes'> & {
  nodes?: RawSnapshotNode[];
  backend: Extract<
    SnapshotBackend,
    'android' | 'harmonyos-arkui' | 'xctest' | 'linux-atspi' | 'web'
  >;
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
  type(text: string, delayMs?: number): Promise<TypeTextBackendResult | void>;
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
