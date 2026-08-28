import type { BackMode } from './back-mode.ts';
import type { DeviceRotation } from './device-rotation.ts';
import type { ScrollDirection } from './scroll-gesture.ts';
import type { ScrollExecutionOptions } from './scroll-command.ts';
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
  SnapshotOptions as BaseSnapshotOptions,
  SnapshotProvenance,
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

export type PressPointOptions = Readonly<{
  button: 'primary' | 'secondary' | 'middle';
  count: number;
  intervalMs: number;
  holdMs: number;
  jitterPx: number;
  doubleTap: boolean;
  surface?: SessionSurface;
}>;

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
 * (readTypeTextBackendResult, packages/platform-apple/src/interactions.ts) drops a
 * route it cannot name — so a Swift-side addition would silently vanish. The
 * route-parity test in packages/platform-apple/src/core/__tests__/interactions.test.ts
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
 * narrows it (readFillBackendResult in the touch handler) drops a
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

/**
 * Android's live IME status read. Optional on {@link Interactor}: parity with the retired leaf,
 * which refused `status`/`get` on every other family (no other platform's runner exposes one).
 * A single-member discriminated union rather than a bare object so the daemon can derive its wire
 * `platform` label from `kind` the same way it does for dismiss and enter — an owner can only ever
 * produce its own result shape.
 */
export type KeyboardStatusResult = Readonly<{
  kind: 'ime-probe';
  visible: boolean;
  inputType?: string;
  type?: string;
  inputMethodPackage?: string;
  focusedPackage?: string;
  focusedResourceId?: string;
  inputOwner?: string;
}>;

/**
 * Owner-shaped dismiss evidence, discriminated by which owner produced it: Android's IME probe
 * fields, or iOS's `mechanism` disclosure (#1598), or HarmonyOS's bare acknowledgment (its HDC
 * key press reports nothing beyond success). The daemon derives the wire `platform` label from
 * `kind` rather than re-deriving it from the device, so an owner can only ever produce its own
 * result shape — an android-probe result under an `ios` label is unrepresentable.
 */
export type KeyboardDismissResult =
  | Readonly<{
      kind: 'ime-probe';
      attempts?: number;
      wasVisible?: boolean;
      dismissed?: boolean;
      visible?: boolean;
      inputType?: string;
      type?: string;
      inputMethodPackage?: string;
      focusedPackage?: string;
      focusedResourceId?: string;
      inputOwner?: string;
    }>
  | Readonly<{
      kind: 'mechanism';
      wasVisible?: boolean;
      dismissed?: boolean;
      visible?: boolean;
      mechanism?: string;
    }>
  | Readonly<{ kind: 'acknowledged' }>;

/**
 * Only the Apple runner echoes visibility around the return-key press; Android and HarmonyOS
 * acknowledge with no fields beyond success. Kind is owner-specific, not just content-shaped —
 * Android's and HarmonyOS's acknowledgments are structurally identical, so only the discriminant
 * itself tells the daemon which owner actually pressed enter.
 */
export type KeyboardEnterResult =
  | Readonly<{ kind: 'visibility-echo'; visible?: boolean; wasVisible?: boolean }>
  | Readonly<{ kind: 'android-acknowledged' }>
  | Readonly<{ kind: 'harmonyos-acknowledged' }>;

/**
 * Every acquisition carries its provenance pair atomically: the channel alone cannot say who
 * acquired the tree or which guarantees it carries, and `SnapshotProvenance`
 * (`@agent-device/kernel/snapshot`) makes a cross-channel `backend`/`producer` combination
 * fail to compile.
 */
export type SnapshotResult = Omit<BackendSnapshotResult, 'backend' | 'nodes'> & {
  nodes?: RawSnapshotNode[];
} & SnapshotProvenance;

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
  /** Complete point-press semantics for owners with fused series, alternate buttons, or surfaces. */
  pressPoint?(point: Point, options: PressPointOptions): Promise<Record<string, unknown> | void>;
  /** Alternate mouse buttons for owners that otherwise use the shared point-press series. */
  alternateClick?(
    point: Point,
    button: 'secondary' | 'middle',
  ): Promise<Record<string, unknown> | void>;
  /** Owner-native ref routes; currently the managed web runtime is their only local owner. */
  tapRef?(ref: string): Promise<Record<string, unknown> | void>;
  tapElementSelector?(selector: ElementSelectorTapOptions): Promise<Record<string, unknown> | void>;
  doubleTap(x: number, y: number): Promise<Record<string, unknown> | void>;
  longPress(x: number, y: number, durationMs?: number): Promise<Record<string, unknown> | void>;
  /**
   * Move the pointer to a point without pressing. Only pointer-driven
   * platforms (web today) implement it; touch platforms have no hover state
   * and leave it undefined, which the `hover` command reports as unsupported.
   */
  hover?(x: number, y: number): Promise<Record<string, unknown> | void>;
  hoverRef?(ref: string): Promise<Record<string, unknown> | void>;
  focus(x: number, y: number): Promise<Record<string, unknown> | void>;
  type(text: string, delayMs?: number): Promise<TypeTextBackendResult | void>;
  /**
   * Replace the target's text with `text`. The empty string is the clear request (#2063), not a
   * no-op: an implementation must empty the field or fail — never report success over an
   * untouched value. A backend with no clear mechanism refuses the empty text up front (see the
   * webdriver interactor).
   */
  fill(
    x: number,
    y: number,
    text: string,
    delayMs?: number,
    options?: { allowNonHittableCoordinateFallback?: boolean },
  ): Promise<Record<string, unknown> | void>;
  fillRef?(ref: string, text: string, delayMs?: number): Promise<Record<string, unknown> | void>;
  scroll(
    direction: ScrollDirection,
    options?: ScrollExecutionOptions,
  ): Promise<Record<string, unknown> | void>;
  screenshot(outPath: string, options?: ScreenshotOptions): Promise<void>;
  setViewport?(width: number, height: number): Promise<Record<string, unknown> | void>;
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;
  /**
   * Native reading of the live text at a point, when the backend has one. Answers the text the
   * owner can see right now, which can exceed what an already-captured node carries (an editable
   * field whose value is longer than its label). Optional: a backend without it leaves the
   * captured tree as the complete answer.
   */
  readTextAtPoint?(
    point: Point,
    options?: { appBundleId?: string; surface?: SessionSurface; signal?: AbortSignal },
  ): Promise<string | undefined>;
  /**
   * Native text-presence reading, when the backend has one that does not require a tree capture.
   * A `true` answer is authoritative; anything else means "not proven here" and the caller
   * consults the canonical tree (see `FindTextResult`).
   */
  findText?(
    text: string,
    options?: { appBundleId?: string; signal?: AbortSignal },
  ): Promise<{
    found: boolean;
  }>;
  /** Native one-sided observation for a simple selector; false defers to canonical capture. */
  findSelector?(
    selector: Readonly<{ key: ElementSelectorKey; value: string }>,
    options?: { appBundleId?: string; signal?: AbortSignal },
  ): Promise<{ found: boolean }>;
  gestureViewport?(): Promise<Rect>;
  back(mode?: BackMode): Promise<void>;
  home(): Promise<void>;
  setOrientation(orientation: DeviceRotation): Promise<{ orientation?: DeviceRotation } | void>;
  performGesture?(plan: GesturePlan): Promise<Record<string, unknown> | void>;
  appSwitcher(): Promise<void>;
  tvRemote(button: TvRemoteButton, durationMs?: number): Promise<void>;
  /** Optional: only Android implements a live status read (see {@link KeyboardStatusResult}). */
  keyboardStatus?(): Promise<KeyboardStatusResult>;
  /** Optional: platforms with no keyboard-dismiss concept leave it undefined. */
  keyboardDismiss?(): Promise<KeyboardDismissResult>;
  /** Optional: platforms with no keyboard-return concept leave it undefined. */
  keyboardEnter?(): Promise<KeyboardEnterResult>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  setSetting(
    setting: string,
    state: string,
    appId?: string,
    options?: SettingOptions,
  ): Promise<Record<string, unknown> | void>;
  /**
   * The four alert legs. Each owner runs its own observation and, where it needs one, its own
   * poll: an alert is a transient device surface, and how long to look for it — and how to press
   * its buttons — is family mechanics, not something a caller can supply. `timeoutMs` is the
   * whole window the caller allows; the owner spends it however its backend requires.
   */
  readAlert(options?: AlertInteractorOptions): Promise<Record<string, unknown>>;
  awaitAlert(options?: AlertInteractorOptions): Promise<Record<string, unknown>>;
  acceptAlert(options?: AlertInteractorOptions): Promise<Record<string, unknown>>;
  dismissAlert(options?: AlertInteractorOptions): Promise<Record<string, unknown>>;
};

/**
 * The session-derived target one alert leg acts on. `appBundleId` is separate from the runner
 * context's because the macOS helper reads a frontmost-app surface with no bundle at all, and
 * the two must not collapse into one field that means both.
 */
export type AlertInteractorOptions = {
  timeoutMs?: number;
  appBundleId?: string;
  surface?: SessionSurface;
};
