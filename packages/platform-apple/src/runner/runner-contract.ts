import { AppError, createRequestCanceledError, toAppErrorCode } from '@agent-device/kernel/errors';
import crypto from 'node:crypto';
import { ALERT_NOT_FOUND_RUNNER_CODE } from '@agent-device/contracts/alert-contract';
import type { DeviceRotation } from '@agent-device/contracts/device';
import type { SnapshotPreferredBackend } from '@agent-device/kernel/snapshot';
import type { ClickButton } from '@agent-device/contracts/click-button';
import type { ElementSelectorKey } from '@agent-device/contracts/interactor-types';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { ScrollReleaseBehavior } from '@agent-device/contracts/scroll-command';
import { getRequestSignal, isRequestCanceled } from './host.ts';

/**
 * The runner's own code for "an earlier command exceeded the execution watchdog and its abandoned
 * main-thread work is still draining" (#1105). It is transient by construction — past the wedge
 * threshold the runner escalates to `RUNNER_WEDGED` instead — so every host path must publish it
 * as retriable.
 */
export const RUNNER_BUSY_RUNNER_CODE = 'RUNNER_BUSY';

/**
 * The runner's own code for the command that just tripped the execution watchdog: its main-thread
 * work was abandoned and the thread is now occupied (#2552). Unlike `RUNNER_BUSY` (a fast refusal
 * of a *later* command), this is the error the *stalling* command itself returns, so it is the only
 * typed signal available before any refusal happens. Not retriable: the wait already elapsed and an
 * immediate retry would only meet `RUNNER_BUSY`.
 */
export const MAIN_THREAD_TIMEOUT_RUNNER_CODE = 'MAIN_THREAD_TIMEOUT';

/**
 * The runner's own code for a read whose session app is not running. No runner read launches the
 * app — a bare launch would drop the payload of a launch still pending, such as a deep link held
 * behind SpringBoard's confirmation — so the runner refuses any command carrying its read-only
 * trait, including a mutation's leading read (a gesture's viewport read, a selector's resolving
 * capture). Only the iOS runner refuses (`#if os(iOS)`); the macOS, tvOS and visionOS runners keep the
 * activate repair. The refusal describes one poll: the launch that confirmation releases may still be
 * starting when the next read arrives, so it is retriable for a `wait`, while the transport reads
 * it as a definite answer and never resends it.
 */
export const APP_NOT_RUNNING_RUNNER_CODE = 'APP_NOT_RUNNING';

export type RunnerCommand = {
  command:
    | 'tap'
    | 'mouseClick'
    | 'longPress'
    | 'drag'
    | 'remotePress'
    | 'type'
    | 'swipe'
    // Fused frame-resolve + drag scroll (non-tvOS). Intentionally mutating in runner command
    // traits so it routes through single-send, command-id tracking, and lost-response status
    // recovery like other gestures.
    | 'scroll'
    // macOS-only frame-resolve + desktop wheel scroll. Kept distinct from `scroll` so mobile
    // touch drag semantics remain stable.
    | 'desktopScroll'
    | 'findText'
    | 'querySelector'
    | 'readText'
    | 'snapshot'
    | 'screenshot'
    | 'backInApp'
    | 'backSystem'
    | 'home'
    | 'rotate'
    | 'gesture'
    | 'gestureViewport'
    | 'appSwitcher'
    | 'actionButton'
    | 'keyboardDismiss'
    | 'keyboardReturn'
    | 'alert'
    | 'sequence'
    | 'recordStart'
    | 'recordStop'
    | 'status'
    | 'uptime'
    // The session app's XCUIApplication.state by name. A lifecycle read: it skips the activation
    // preflight, so it reports the state the app is in rather than the one a repair leaves.
    | 'appState'
    | 'activate'
    | 'terminate'
    | 'targetReset'
    | 'shutdown';
  commandId?: string;
  statusCommandId?: string;
  appBundleId?: string;
  text?: string;
  selectorKey?: ElementSelectorKey;
  selectorValue?: string;
  allowNonHittableCoordinateFallback?: boolean;
  delayMs?: number;
  textEntryMode?: 'append' | 'replace';
  action?: 'get' | 'accept' | 'dismiss';
  x?: number;
  y?: number;
  button?: ClickButton;
  remoteButton?: 'select' | 'menu' | 'home' | 'up' | 'down' | 'left' | 'right';
  x2?: number;
  y2?: number;
  durationMs?: number;
  /** Remaining request budget for runner work that performs bounded XCTest queries. */
  timeoutMs?: number;
  direction?: ScrollDirection;
  amount?: number;
  pixels?: number;
  scrollReleaseBehavior?: ScrollReleaseBehavior;
  orientation?: DeviceRotation;
  /** Canonical pointer samples planned by the portable gesture runtime. */
  gesturePlan?: GesturePlan;
  outPath?: string;
  fps?: number;
  interactiveOnly?: boolean;
  /** Pin the snapshot capture backend (same-backend evidence probes). */
  preferredBackend?: SnapshotPreferredBackend;
  /**
   * Read accessibility custom actions for merged leaves. Opt-in: each element
   * costs its own AX round trip, and the runner pins the private-AX backend
   * because no other backend can carry them.
   */
  customActions?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  fullscreen?: boolean;
  inlineScreenshot?: boolean;
  synthesized?: boolean;
  steps?: RunnerSequenceStep[];
};

/**
 * One allowlisted coordinate gesture step inside a fused `sequence` runner command.
 * The kind set is intentionally narrow (tap/doubleTap/longPress) and validated on both the
 * daemon and runner sides — see runner-sequence.ts (the single interpretation point).
 */
export type RunnerSequenceStep = {
  kind: 'tap' | 'doubleTap' | 'longPress';
  x: number;
  y: number;
  durationMs?: number;
  pauseMs?: number;
  /**
   * For `tap` steps on iOS non-tv: use the synthesized HID tap (synthesizedTapAt) fast path
   * instead of the drag-based XCUICoordinate tapAt, matching the individual `tap` command.
   */
  synthesized?: boolean;
};

export function resolveRunnerRequestSignal(options: {
  requestId?: string;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  const registeredSignal = getRequestSignal(options.requestId);
  if (!options.signal) return registeredSignal;
  if (!registeredSignal || registeredSignal === options.signal) return options.signal;
  return AbortSignal.any([registeredSignal, options.signal]);
}

/**
 * The code the XCTest runner answers with when it declines to place a scroll gesture under the
 * on-screen keyboard (#2500). It is the runner's own vocabulary, so it is declared here beside the
 * set that keeps it off the wire, and the Apple scroll owner matches it on `details.runnerErrorCode`
 * rather than on error text.
 */
export const SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE = 'SCROLL_KEYBOARD_OCCLUDES_SURFACE';

/**
 * The codes the XCTest runner answers with when a resolved-display capture it was asked to make did
 * not happen (#2728): no window resolved so no display could be named, the resolved window named no
 * display, or the resolved display handed back an image it could not encode upright. The runner emits
 * them from every consumer of that helper — the `screenshot` command's fallback, `record start`'s
 * required first frame, and an optional visual check such as the `back` fallback's before/after
 * sample. They are the runner's own vocabulary, so they are declared here beside the set that keeps
 * them off the wire; a required capture fails closed on them rather than falling back to a screen
 * nobody is on, and an optional one reports the refusal as an unknown. Only the `screenshot` route
 * consumes the set for its own simctl-to-runner decision, but the set names the whole family.
 */
const RUNNER_SCREEN_WINDOW_UNRESOLVED_RUNNER_CODE = 'APP_SCREEN_WINDOW_UNRESOLVED';
const RUNNER_SCREEN_UNRESOLVED_RUNNER_CODE = 'APP_SCREEN_UNRESOLVED';
const RUNNER_SCREEN_CAPTURE_UNRENDERABLE_RUNNER_CODE = 'APP_SCREEN_CAPTURE_UNRENDERABLE';

/** Every runner code meaning "this capture did not happen", covering the display and the image. */
export const RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES: ReadonlySet<string> = new Set([
  RUNNER_SCREEN_WINDOW_UNRESOLVED_RUNNER_CODE,
  RUNNER_SCREEN_UNRESOLVED_RUNNER_CODE,
  RUNNER_SCREEN_CAPTURE_UNRENDERABLE_RUNNER_CODE,
]);

/**
 * Runner codes that classify a failure for the host without renaming it on the wire. They stay
 * `COMMAND_FAILED` and survive as `details.runnerErrorCode`, which is what family policy reads:
 * `RUNNER_BUSY` for retriable contention, `ALERT_NOT_FOUND` for an alert that is not there yet,
 * the scroll keyboard refusal for a surface the runner declined to swipe under the keys, and the
 * retriable `APP_NOT_RUNNING` for a read the runner refused rather than launch the session app.
 */
const DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES: ReadonlyMap<string, { retriable?: true }> = new Map([
  [RUNNER_BUSY_RUNNER_CODE, { retriable: true }],
  [MAIN_THREAD_TIMEOUT_RUNNER_CODE, {}],
  [APP_NOT_RUNNING_RUNNER_CODE, { retriable: true }],
  [ALERT_NOT_FOUND_RUNNER_CODE, {}],
  [SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE, {}],
  ...[...RUNNER_SCREEN_CAPTURE_REFUSAL_RUNNER_CODES].map((code) => [code, {}] as const),
]);

/** Wire code plus the details every path must publish for one runner-reported error code. */
export type RunnerReportedErrorClass = Readonly<{
  code: AppError['code'];
  details: Readonly<{ runnerErrorCode?: string; retriable?: true }>;
}>;

/**
 * The one reading of a runner-reported error code (#2484 follow-up). A runner failure reaches the
 * host by two routes — the command's own response, and the lifecycle journal a status probe reads
 * back after the transport response was lost — and both must classify it identically, or the same
 * runner condition surfaces under two codes with only one of them marked retriable.
 */
export function classifyRunnerReportedError(
  runnerErrorCode: string | undefined,
): RunnerReportedErrorClass {
  const diagnosticOnly =
    runnerErrorCode === undefined
      ? undefined
      : DIAGNOSTIC_ONLY_RUNNER_ERROR_CODES.get(runnerErrorCode);
  return Object.freeze({
    code: diagnosticOnly ? 'COMMAND_FAILED' : toAppErrorCode(runnerErrorCode),
    details: Object.freeze({ runnerErrorCode, ...diagnosticOnly }),
  });
}

export type RunnerResponsePayload = {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown; hint?: unknown };
  data?: unknown;
};

/**
 * The one decoding of a runner response body (#2662). The envelope arrives at three readers — a
 * command's own response, the lifecycle journal a status probe reads back after the transport
 * response was lost, and the adoption `uptime` probe — and all three must agree on what is
 * readable, or a body one of them refuses becomes an answer for another. A body that is not JSON
 * at all is transport-shaped failure: a runner that died mid-write must not be read as having
 * answered.
 */
export function decodeRunnerResponseBody(text: string): RunnerResponsePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('COMMAND_FAILED', 'Invalid runner response', { text });
  }
  return parsed && typeof parsed === 'object' ? (parsed as RunnerResponsePayload) : {};
}

/** The runner's `ok` is a Swift `Bool`, so only the literal `true` is an answer. */
export function isRunnerResponseOk(payload: RunnerResponsePayload): boolean {
  return payload.ok === true;
}

export function readRunnerResponseData(payload: RunnerResponsePayload): Record<string, unknown> {
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return {};
  return payload.data as Record<string, unknown>;
}

export function buildRunnerResponseError(
  payload: RunnerResponsePayload,
  logPath?: string,
): AppError {
  const runnerErrorCode = readRunnerErrorCode(payload.error?.code);
  const errorMessage =
    typeof payload.error?.message === 'string' ? payload.error.message : undefined;
  const hint = typeof payload.error?.hint === 'string' ? payload.error.hint : undefined;
  const classification = classifyRunnerReportedError(runnerErrorCode);
  return new AppError(classification.code, errorMessage ?? 'Runner error', {
    runner: payload,
    ...classification.details,
    xcodebuild: {
      exitCode: 1,
      stdout: '',
      stderr: '',
    },
    hint,
    logPath,
  });
}

function readRunnerErrorCode(rawCode: unknown): string | undefined {
  return typeof rawCode === 'string' && rawCode.trim().length > 0 ? rawCode.trim() : undefined;
}

export function withRunnerCommandId(command: RunnerCommand): RunnerCommand {
  if (command.command === 'status') return command;
  if (command.commandId?.trim()) return command;
  return { ...command, commandId: createRunnerCommandId() };
}

function createRunnerCommandId(): string {
  return `runner-${crypto.randomUUID()}`;
}

export function assertRunnerRequestActive(requestId: string | undefined): void {
  if (!isRequestCanceled(requestId)) return;
  throw createRequestCanceledError();
}
