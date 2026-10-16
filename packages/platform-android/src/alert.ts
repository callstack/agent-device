import {
  type AlertAction,
  ALERT_ACTION_RETRY_MS,
  ALERT_BUTTON_UNDECIDED_REASON,
  ALERT_CAPTURE_UNDECIDED_REASON,
  type AlertCapture,
  type AlertInfo,
  type AlertPlatform,
  ALERT_NOT_FOUND_REASON,
  ALERT_POLL_INTERVAL_MS,
  ALERT_WINDOW_EXPIRED_REASON,
  type AlertStatusKind,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { type DeadlineClock, Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import { successText } from '@agent-device/kernel/success-text';

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  chooseAndroidAlertButton,
  findAndroidAlertCandidate,
  type AndroidAlertButton,
  type AndroidAlertCandidate,
  type AndroidAlertInfo,
} from './alert-detection.ts';
import { backAndroid, pressAndroid } from './input-actions.ts';

/**
 * THE tree-based alert driver (PR #3699 review): every backend that reads alerts out of a
 * capture tree — the Android ADB legs here and the Limrun iOS legs in `provider-limrun` —
 * reaches poll, confirm, same-alert, refusal, and response building through this one module,
 * and its button roles through the shared label vocabulary in `contracts/alert-contract`. A
 * backend supplies only its own observation (`capture` + `findCandidate`), its platform's
 * acting policy (`choose`), and its press seam (`press`).
 */

/** The point a press seam aims at: a button's center in the backend's own coordinate space. */
export type TreeAlertButton = Readonly<{ label: string; x: number; y: number }>;

/**
 * What one capture says about alerts; the one three-way observation lives in the alert
 * contract next to the shared vocabulary, and every tree backend's reader answers in it.
 */
export type TreeAlertObservation<TCandidate> = AlertCapture<TCandidate>;

/** One acting choice: press a named button, or press a platform fallback key (Android Back). */
export type TreeAlertPress<TButton extends TreeAlertButton> =
  | { kind: 'press'; button: TButton }
  | { kind: 'fallback'; label: string };

export type TreeAlertCandidate<
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
> = Readonly<{
  alert: TAlert;
  buttons: TButton[];
}>;

/**
 * The seams one tree-based backend owns. `timeoutMs` bounds `wait`; the acting legs ride the
 * contract action budget. Poll sleeps ride the shared `pollUntilSettled` deadline primitive, so
 * tests drive the clock (`docs/agents/testing.md`) rather than the driver owning a timer seam.
 * `capture` and `press` receive the live cancellation signal for their attempt — the caller's
 * request signal joined with the loop's remaining window — so a backend whose transport can be
 * canceled stops in-flight work, and every backend refuses to consume a capture or dispatch a
 * press once the signal has fired. A transport that cannot cancel still gains both refusals.
 */
export type TreeAlertSeam = Readonly<{ signal: AbortSignal }>;

export type TreeAlertDriver<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
> = Readonly<{
  platform: TPlatform;
  timeoutMs?: number;
  /** The daemon request's cancellation, when the caller rides one; joined into every seam call. */
  signal?: AbortSignal;
  /**
   * One capture, offered the leg's live signal. A backend whose transport can abort (Android's
   * adb executor kills the child) hands it down; a backend whose transport cannot (Limrun's
   * WebSocket client) ignores it, and the driver's window guard is what keeps its late captures
   * unconsumed.
   */
  capture: (seam: TreeAlertSeam) => Promise<TCapture>;
  findCandidate: (capture: TCapture) => TreeAlertObservation<TCandidate>;
  choose: (candidate: TCandidate, action: 'accept' | 'dismiss') => TreeAlertPress<TButton> | null;
  press: (choice: TreeAlertPress<TButton>, seam: TreeAlertSeam) => Promise<void>;
}>;

/** The records the daemon composes CLI and SDK output around, identical across tree backends. */
export type TreeAlertResult<
  TAlert extends AlertInfo & { buttons: string[] },
  TPlatform extends AlertPlatform,
> =
  | {
      kind: 'alertStatus';
      platform: TPlatform;
      action: 'get';
      alert: TAlert | null;
      /** Typed absence vs. an unresolvable capture, so clients switch on states, not messages. */
      status: AlertStatusKind;
      message?: string;
    }
  | {
      kind: 'alertWait';
      platform: TPlatform;
      action: 'wait';
      alert: TAlert;
      waitedMs: number;
      message?: string;
    }
  | {
      kind: 'alertHandled';
      platform: TPlatform;
      action: 'accept' | 'dismiss';
      handled: true;
      alert: TAlert;
      button: string;
      coordinates?: { x: number; y: number };
      message?: string;
    };

/** One observation of the backend's own capture, bound by the driver from its two seams. */
type TreeAlertObserver<TCandidate> = () => Promise<TreeAlertObservation<TCandidate>>;

const ALERT_NOT_FOUND_HINT =
  'If a sheet is visible in snapshot but alert reports no alert, it is likely app-owned UI. Use snapshot -i and press the visible label/ref.';

/**
 * Runs one alert leg. The deadline order is read-first on every budget: over a positive window
 * both predecessor loops took their first immediate observation before any waiting, and one
 * immediate observation is the honest answer shape for a zero-length `wait` window too. A
 * malformed `timeoutMs` is the bounded default, never a loop whose bound is never reached.
 *
 * Every budget also bounds the work inside it: each polling leg carries a window signal that
 * expires with its deadline and a request signal from the caller, and both reach the seams.
 * Captures then stop in-flight transport work wherever the backend's transport can cancel (the
 * Android legs hand the signal to the adb executor, which kills the child); backends whose
 * transport cannot cancel — Limrun's WebSocket client exposes no abort — still never consume a
 * capture that lands after its window closed, and no press is dispatched past the window.
 */
export async function runTreeAlertAction<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
>(
  action: AlertAction,
  driver: TreeAlertDriver<TCapture, TAlert, TButton, TCandidate, TPlatform>,
): Promise<TreeAlertResult<TAlert, TPlatform>> {
  if (action === 'get') {
    // One immediate observation with no window to expire: only the caller's cancellation binds it.
    const observe = treeAlertObserver(driver, undefined);
    return buildTreeAlertStatusResponse(driver.platform, await observe());
  }
  if (action === 'wait') {
    const start = Date.now();
    const window = treeAlertWindow(alertWindowMs(driver.timeoutMs), driver.signal);
    const observe = treeAlertObserver(driver, window);
    let polled: TreeAlertObservation<TCandidate>;
    try {
      polled = await pollTreeAlert(observe, window, driver.signal);
    } catch (error) {
      // A capture the window cut off is, for `wait`, exactly what the window closing means.
      if (isAlertWindowExpired(error)) throw new AppError('COMMAND_FAILED', 'alert wait timed out');
      throw error;
    }
    if (polled.kind !== 'alert') {
      // Both a quiet capture and one that stayed alert-shaped yet unresolvable mean no
      // actionable alert ever resolved within the window; the timeout phrasing is the honest
      // answer for either.
      throw new AppError('COMMAND_FAILED', 'alert wait timed out');
    }
    return {
      kind: 'alertWait',
      platform: driver.platform,
      action: 'wait',
      alert: polled.candidate.alert,
      waitedMs: Date.now() - start,
      ...successText('Alert visible'),
    };
  }
  return await actOnTreeAlert(action, driver);
}

/** What the observer reads of a driver: the two seams it runs and the signal it joins. */
type ObserverDriver<TCapture, TCandidate> = Readonly<{
  signal?: AbortSignal;
  capture: (seam: TreeAlertSeam) => Promise<TCapture>;
  findCandidate: (capture: TCapture) => TreeAlertObservation<TCandidate>;
}>;

/**
 * One observation of the backend's capture, bound by the driver's window. `window` is the leg's
 * deadline clock plus the joined signal (this window's expiry, the caller's cancellation) the
 * seams carry. Android hands that signal to the adb executor, which kills the child process, so
 * a capture in flight when the window closes is actually stopped; Limrun's WebSocket client
 * exposes no abort, so the post-await check here is what keeps that backend honest — a capture
 * that lands once its window has closed proves nothing, is refused on the typed window reason,
 * and is never consumed. A probe that starts once the window is already spent is the polling
 * loop's own closing observation: it answers normally and the loop ends on its deadline. What
 * may never happen is consuming a spent-window observation as actionable, which the press-time
 * window check in `actOnTreeAlert` enforces. The first observation of a leg rides only the
 * caller's cancellation: the read-first contract promises one immediate honest answer even when
 * the window is already spent, and a probe that starts inside the window cannot have outrun a
 * deadline it has not reached yet — its own landing decides, not a race with the clock.
 */
type TreeAlertWindow = Readonly<{ deadline: DeadlineClock; signal: AbortSignal }>;

/**
 * One leg's window: a deadline clock the driver polls against and the joined signal (this
 * window's expiry, the caller's cancellation) the seams carry. The clock and signal start on
 * the same line, so an expired clock and an aborted signal agree on everything but the
 * millisecond.
 */
function treeAlertWindow(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): TreeAlertWindow {
  return {
    deadline: Deadline.fromTimeoutMs(timeoutMs),
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]),
  };
}

function treeAlertObserver<TCapture, TCandidate>(
  driver: ObserverDriver<TCapture, TCandidate>,
  window: TreeAlertWindow | undefined,
): TreeAlertObserver<TCandidate> {
  return async () => {
    if (driver.signal?.aborted) throw createRequestCanceledError();
    // A window already spent at probe start is the polling loop's own closing observation: it
    // answers normally (the read-first contract keeps one immediate honest answer even for a
    // spent window) and the loop ends on its deadline. A probe that starts inside the window is
    // guarded: its seam can be canceled, and its landing is checked against the clock.
    const guarded = window !== undefined && !window.deadline.isExpired();
    const capture = await captureAlertState(
      driver,
      guarded ? window.signal : (driver.signal ?? neverSignal),
    );
    if (guarded && window.deadline.isExpired() && !driver.signal?.aborted) {
      throw alertWindowExpiredError('no');
    }
    return driver.findCandidate(capture);
  };
}

/**
 * One seam capture. Inside its window the seam signal can cut the transport mid-flight; a
 * capture refused by its own window signal is exactly the outrunning capture, and reports the
 * typed cause. The caller's own cancellation always surfaces as the shared cancellation error.
 */
async function captureAlertState<TCapture>(
  driver: ObserverDriver<TCapture, unknown>,
  seamSignal: AbortSignal,
): Promise<TCapture> {
  try {
    return await driver.capture({ signal: seamSignal });
  } catch (error) {
    if (driver.signal?.aborted) throw createRequestCanceledError();
    if (seamSignal.aborted) throw alertWindowExpiredError('no');
    throw error;
  }
}

/**
 * The failure one seam call took when its signal cut it off: the caller canceled, or the leg's
 * window closed mid-capture. `dispatched` stays 'no' for pre-press legs; the confirm leg, which
 * runs after a press already landed, maps it to its own stuck-alert failure instead.
 */
function alertSeamInterrupted(canceled: boolean): AppError {
  if (canceled) throw createRequestCanceledError();
  return alertWindowExpiredError('no');
}

function alertWindowExpiredError(dispatched: 'no'): AppError {
  return new AppError('COMMAND_FAILED', 'alert window expired before the action could complete', {
    reason: ALERT_WINDOW_EXPIRED_REASON,
    dispatched,
    hint: 'The capture outran the alert budget; nothing was pressed. Retry alert get to see the current state.',
  });
}

function isAlertWindowExpired(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.details as { reason?: unknown } | undefined)?.reason === ALERT_WINDOW_EXPIRED_REASON
  );
}

/** The seam signal for a leg with no window and no caller cancellation: nothing can cancel it. */
const neverSignal = new AbortController().signal;

function alertWindowMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : DEFAULT_ALERT_TIMEOUT_MS;
}

/**
 * Polls for an actionable candidate within the budget, on the same deadline primitive the
 * daemon's other polling loops ride. The terminal answer distinguishes a window that stayed
 * quiet (`none`) from one that stayed alert-shaped yet unresolvable (`undecided`): a degraded
 * sheet that never resolved is not an absence, and callers must not report the two alike.
 */
async function pollTreeAlert<TCandidate>(
  observe: TreeAlertObserver<TCandidate>,
  window: TreeAlertWindow,
  signal?: AbortSignal,
): Promise<TreeAlertObservation<TCandidate>> {
  let sawUndecided = false;
  const { settled, value } = await pollUntilSettled({
    probe: observe,
    settled: (observation) => {
      if (observation.kind === 'undecided') sawUndecided = true;
      return observation.kind === 'alert';
    },
    deadline: window.deadline,
    intervalMs: ALERT_POLL_INTERVAL_MS,
    signal,
  });
  if (settled) return value;
  return sawUndecided ? { kind: 'undecided' } : { kind: 'none' };
}

/**
 * Accept and dismiss share one contract on every tree backend: look within the action budget,
 * press exactly the one choice the action's role names, then confirm the alert is gone.
 * `dismiss` never authorizes anything — an alert whose denying choice cannot be named is
 * reported as the ambiguity it is instead of pressing something.
 */
async function actOnTreeAlert<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
>(
  action: 'accept' | 'dismiss',
  driver: TreeAlertDriver<TCapture, TAlert, TButton, TCandidate, TPlatform>,
): Promise<TreeAlertResult<TAlert, TPlatform>> {
  const lookupWindow = treeAlertWindow(ALERT_ACTION_RETRY_MS, driver.signal);
  const observe = treeAlertObserver(driver, lookupWindow);
  let polled: TreeAlertObservation<TCandidate>;
  try {
    polled = await pollTreeAlert(observe, lookupWindow, driver.signal);
  } catch (error) {
    if (isAlertWindowExpired(error)) {
      throw new AppError(
        'COMMAND_FAILED',
        `alert ${action} refused: the action budget closed before an alert resolved`,
        {
          reason: ALERT_WINDOW_EXPIRED_REASON,
          dispatched: 'no',
          hint: 'Nothing was pressed. Retry alert get to see the current state.',
        },
      );
    }
    throw error;
  }
  if (polled.kind === 'undecided') {
    throw new AppError(
      'COMMAND_FAILED',
      `alert ${action} refused: the capture is alert-shaped but cannot be resolved to one alert`,
      {
        reason: ALERT_CAPTURE_UNDECIDED_REASON,
        dispatched: 'no',
        hint: 'Inspect alert get --json and snapshot -i, then press the visible choice by label/ref.',
      },
    );
  }
  if (polled.kind === 'none') {
    throw new AppError('COMMAND_FAILED', 'alert not found', {
      reason: ALERT_NOT_FOUND_REASON,
      dispatched: 'no',
      hint: ALERT_NOT_FOUND_HINT,
    });
  }
  const candidate = polled.candidate;
  const choice = driver.choose(candidate, action);
  if (!choice) {
    throw new AppError(
      'COMMAND_FAILED',
      `alert ${action} found an alert but no button that clearly matches the action`,
      {
        reason: ALERT_BUTTON_UNDECIDED_REASON,
        dispatched: 'no',
        alert: candidate.alert,
        hint: 'Inspect alert get --json for the visible buttons, then press the choice you want by label/ref.',
      },
    );
  }
  // The press rides the lookup's remaining window and the caller's cancellation: a press whose
  // window closed before it went out has not pressed anything, and says so on a typed `no`.
  const pressSignal = lookupWindow.signal;
  if (pressSignal.aborted) throw alertSeamInterrupted(driver.signal?.aborted === true);
  try {
    await driver.press(choice, { signal: pressSignal });
  } catch (error) {
    // A press cut off mid-flight cannot report what the device already received: the tap may
    // or may not have been dispatched. That uncertainty is typed, never a clean 'no'.
    if (pressSignal.aborted) {
      if (driver.signal?.aborted) throw createRequestCanceledError();
      throw new AppError(
        'COMMAND_FAILED',
        `alert ${action} was cut off while pressing; the press may or may not have landed`,
        {
          reason: ALERT_WINDOW_EXPIRED_REASON,
          dispatched: 'unknown',
          alert: candidate.alert,
          hint: 'Inspect alert get --json before retrying: the dialog may already be gone.',
        },
      );
    }
    throw error;
  }
  // The confirm window is its own budget: it only starts once the press has been dispatched,
  // and it must not consume the lookup's already-spent window. A capture this phase cuts off
  // lands after a press, so its failure keeps the stuck-alert phrasing, never "nothing was
  // pressed" — the confirm observer maps its window expiry onto that failure below.
  const confirmWindow = treeAlertWindow(ALERT_ACTION_RETRY_MS, driver.signal);
  await confirmTreeAlertDismissed(
    treeAlertObserver(driver, confirmWindow),
    confirmWindow,
    candidate.alert,
    action,
    driver.signal,
  );
  return {
    kind: 'alertHandled',
    platform: driver.platform,
    action,
    handled: true,
    alert: candidate.alert,
    button: choice.kind === 'press' ? choice.button.label : choice.label,
    ...(choice.kind === 'press' ? { coordinates: { x: choice.button.x, y: choice.button.y } } : {}),
    ...successText(`Alert ${action}ed`),
  };
}

/**
 * `alert accept|dismiss` means the dialog is gone, not that a press was sent: the next command
 * reads the app, and a capture that lands while the dialog window is still up sees only the
 * dialog. Only two answers confirm that: observed absence (`none`), or a different alert taking
 * the first's place. An undecided post-press capture proves nothing about absence, so it is
 * retried within the budget and reported as a failure at its end rather than returned as
 * handled. Bounded by the same budget the pre-press lookup uses; iOS's runner applies the same
 * re-check.
 */
async function confirmTreeAlertDismissed<
  TAlert extends AlertInfo & { buttons: string[] },
  TCandidate extends TreeAlertCandidate<TAlert, TreeAlertButton>,
>(
  observe: TreeAlertObserver<TCandidate>,
  window: TreeAlertWindow,
  dismissed: TAlert,
  action: 'accept' | 'dismiss',
  signal?: AbortSignal,
): Promise<void> {
  let settled: boolean;
  try {
    ({ settled } = await pollUntilSettled({
      probe: observe,
      settled: (observation) =>
        observation.kind === 'none' ||
        (observation.kind === 'alert' && !sameTreeAlert(observation.candidate.alert, dismissed)),
      deadline: window.deadline,
      intervalMs: ALERT_POLL_INTERVAL_MS,
      signal,
    }));
  } catch (error) {
    // A confirmation capture this phase cuts off says the same thing a budget spent without
    // confirmation says — and it says it after a press landed, so the stuck-alert phrasing is
    // the honest one here; the typed reason keeps the two causes distinguishable.
    if (isAlertWindowExpired(error)) {
      throw new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
        alert: dismissed,
        reason: ALERT_WINDOW_EXPIRED_REASON,
        hint: 'The alert button was pressed but the dialog is still visible. Inspect alert get --json, then press the visible button by label/ref or retry.',
      });
    }
    throw error;
  }
  if (settled) return;
  throw new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
    alert: dismissed,
    hint: 'The alert button was pressed but the dialog is still visible. Inspect alert get --json, then press the visible button by label/ref or retry.',
  });
}

/** Alert identity across a dismissal re-check: the same title and the same button row, in order. */
function sameTreeAlert(
  left: AlertInfo & { buttons: string[] },
  right: AlertInfo & { buttons: string[] },
): boolean {
  return left.title === right.title && left.buttons.join('\u0000') === right.buttons.join('\u0000');
}

function buildTreeAlertStatusResponse<
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
>(
  platform: TPlatform,
  observation: TreeAlertObservation<TCandidate>,
): TreeAlertResult<TAlert, TPlatform> {
  return {
    kind: 'alertStatus',
    platform,
    action: 'get',
    alert: observation.kind === 'alert' ? observation.candidate.alert : null,
    status:
      observation.kind === 'alert'
        ? 'visible'
        : observation.kind === 'undecided'
          ? 'undecided'
          : 'none',
    ...(observation.kind === 'alert'
      ? successText('Alert visible')
      : observation.kind === 'undecided'
        ? successText('Cannot decide the alert: the capture is alert-shaped but unresolvable')
        : successText('No alert visible')),
  };
}

// --- the Android legs: the driver above plus this platform's own observation and acting policy ---

type AndroidAlertOptions = {
  timeoutMs?: number;
  /** The daemon request's cancellation; the driver joins it into every capture and press. */
  signal?: AbortSignal;
  captureNodes: (seam: TreeAlertSeam) => Promise<RawSnapshotNode[]>;
};

export type AndroidAlertResult = TreeAlertResult<AndroidAlertInfo, 'android'>;

export async function handleAndroidAlert(
  device: DeviceInfo,
  action: AlertAction,
  options: AndroidAlertOptions,
): Promise<AndroidAlertResult> {
  return await runTreeAlertAction<
    RawSnapshotNode[],
    AndroidAlertInfo,
    AndroidAlertButton,
    AndroidAlertCandidate,
    'android'
  >(action, {
    platform: 'android',
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    capture: (seam) =>
      withDiagnosticTimer('snapshot_capture', () => options.captureNodes(seam), {
        backend: 'android',
        purpose: 'alert',
      }),
    // Android's dump either names a candidate or names none; it has no capture state that can
    // reach `undecided`.
    findCandidate: (nodes) => {
      const candidate = findAndroidAlertCandidate(nodes);
      return candidate ? { kind: 'alert', candidate } : { kind: 'none' };
    },
    choose: (candidate, act) => {
      const button = chooseAndroidAlertButton(candidate.buttons, act);
      if (button) return { kind: 'press', button };
      // No button states any leaving choice: dismissing an Android dialog is what the Back
      // key means. The refusal message and typed reason come from the driver, not from here.
      return act === 'dismiss' ? { kind: 'fallback', label: 'Back' } : null;
    },
    press: async (choice, seam) => {
      // The adb executor kills the child on abort, so the press transport itself stops with the
      // leg's signal; whether a canceled tap still reached the device stays typed upstream.
      if (choice.kind === 'press') {
        await pressAndroid(device, choice.button.x, choice.button.y, { signal: seam.signal });
        return;
      }
      await backAndroid(device, { signal: seam.signal });
    },
  });
}
