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
  MAX_ALERT_WINDOW_MS,
} from '@agent-device/contracts/alert-contract';
import { Deadline, type DeadlineClock, pollUntilSettled } from '@agent-device/host-kit/retry';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';

/**
 * The one driver for every backend that reads alerts from a capture tree (Android ADB, Limrun
 * iOS). A backend supplies only its observation (`capture` + `findCandidate`), its acting
 * policy (`choose`), and its press seam (`press`). It lives in the capture kit: an iOS provider
 * must not depend on the Android package to poll a tree.
 *
 * The budget rule: `pollUntilSettled` owns it — every probe started inside the budget is
 * awaited and counts; the deadline ends only the LOOP, never a capture in flight. Only the
 * caller's cancellation stops a transport. A quiet screen therefore answers `alert-not-found`
 * on every backend. The cost: a transport with no abort (Limrun's client) can overrun the
 * budget by one call, and a capture that never returns keeps the leg open until the caller
 * cancels it.
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
 * The seams one tree-based backend owns. `signal` is always the daemon request's own
 * cancellation, never a budget timer: it is what may stop a transport in flight. A transport
 * with no abort (Limrun's client) cannot be stopped this way — its in-flight call keeps running
 * and the leg waits for the answer it started (the overrun named above). The caller meanwhile
 * learns of its cancellation from its own client transport; the daemon's own answer lands once
 * the leg settles on the started probe's answer.
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
  /** The daemon request's cancellation, when the caller rides one; the only seam stop signal. */
  signal?: AbortSignal;
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

const ALERT_NOT_FOUND_HINT =
  'If a sheet is visible in snapshot but alert reports no alert, it is likely app-owned UI. Use snapshot -i and press the visible label/ref.';

/**
 * Runs one alert leg. `get` is a single observation with no budget to bound. `wait` polls one
 * budget for an alert to appear. `accept`/`dismiss` look, press exactly the one choice the
 * action's role names, and confirm the alert is gone. In every leg a started capture finishes
 * on the caller's cancellation alone, and the deadline only ends the polling loop.
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
    // One immediate observation with no budget to expire: only the caller's cancellation binds it.
    return buildTreeAlertStatusResponse(driver.platform, await observeTreeAlert(driver));
  }
  if (action === 'wait') {
    const start = Date.now();
    const polled = (
      await pollTreeAlert(driver, Deadline.fromTimeoutMs(alertWindowMs(driver.timeoutMs)))
    ).value;
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

/**
 * One capture read through the driver's seams, on the caller's cancellation alone. A capture
 * whose seam transport died with that cancellation reports the shared cancellation error, never
 * a raw transport failure: an aborted request must not read as a broken backend.
 */
async function observeTreeAlert<TCapture, TCandidate>(
  driver: TreeAlertObserverDriver<TCapture, TCandidate>,
): Promise<TreeAlertObservation<TCandidate>> {
  if (driver.signal?.aborted) throw createRequestCanceledError();
  let capture: TCapture;
  try {
    capture = await driver.capture({ signal: driver.signal ?? neverSignal });
  } catch (error) {
    if (driver.signal?.aborted) {
      // A capture that dies with the cancellation dispatches nothing on the get/wait/lookup
      // routes; post-press deaths rejoin `actOnTreeAlert`'s catch, which owns the typed 'unknown'.
      throw createRequestCanceledError({ dispatched: 'no' }, error);
    }
    throw error;
  }
  return driver.findCandidate(capture);
}

type TreeAlertObserverDriver<TCapture, TCandidate> = Readonly<{
  signal?: AbortSignal;
  capture: (seam: TreeAlertSeam) => Promise<TCapture>;
  findCandidate: (capture: TCapture) => TreeAlertObservation<TCandidate>;
}>;

/**
 * Polls the driver's observation until `settled` accepts an answer or the budget ends the loop.
 * The budget never cuts a capture: `pollUntilSettled` awaits every probe it starts and clamps
 * each sleep to the deadline, so the terminal answer is what the probes answered, never how the
 * clock fell. With no `settled` given, the loop ends on an alert. `value` is the last answer
 * either way and `sawUndecided` states the window saw an unresolvable capture at some point. The
 * acting lookup is what that fact binds: it decides absence vs undecided there, and a degraded
 * sheet that never resolved is not an absence. The wait leg deliberately ignores it — its
 * timeout phrasing ("no alert resolved within the window") is the honest answer for a quiet
 * screen and for an unresolved sheet alike, and `alert get` remains the undecided reporter.
 */
async function pollTreeAlert<TCapture, TCandidate>(
  driver: TreeAlertObserverDriver<TCapture, TCandidate>,
  deadline: DeadlineClock,
  settled: (observation: TreeAlertObservation<TCandidate>) => boolean = (observation) =>
    observation.kind === 'alert',
): Promise<{ settled: boolean; value: TreeAlertObservation<TCandidate>; sawUndecided: boolean }> {
  let sawUndecided = false;
  const { settled: loopSettled, value } = await pollUntilSettled({
    probe: () => observeTreeAlert(driver),
    settled: (observation) => {
      if (observation.kind === 'undecided') sawUndecided = true;
      return settled(observation);
    },
    deadline,
    intervalMs: ALERT_POLL_INTERVAL_MS,
    signal: driver.signal,
  });
  return { settled: loopSettled, value, sawUndecided };
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
  const polled = await lookupTreeAlert(action, driver);
  // A cancel that arrived while the lookup's last probe was in flight is honored here, before
  // anything is dispatched: the caller withdrew the action, so the press never starts and the
  // exit is the clean pre-press cancellation (`dispatched: no`), not the press-time unknown.
  if (driver.signal?.aborted) {
    throw createRequestCanceledError({ dispatched: 'no' });
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
  // The press rides only the caller's cancellation: once the loop has chosen, the press is the
  // action itself, not a probe a budget may end. From the moment the press starts, every
  // caller-cancelled exit is typed `dispatched: unknown` — the device may already have received
  // the tap — whether the transport dies with the cancel (the catch), answers it AFTER the
  // cancel (a transport with no abort resolves normally on an aborted request: the post-press
  // check), or the cancel arrives during the post-press confirm window. None of them may read
  // as a clean 'no'.
  try {
    await driver.press(choice, { signal: driver.signal ?? neverSignal });
    await confirmTreeAlertGone(driver, candidate.alert, action);
  } catch (error) {
    if (driver.signal?.aborted) {
      throw createRequestCanceledError({ dispatched: 'unknown' }, error);
    }
    throw error;
  }
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
 * The acting leg's lookup phase: the action budget, ended either by a candidate or by the
 * whole window's answer. An unsettled lookup is aggregated over the window, not just its last
 * probe: one undecided capture anywhere in it says the screen held an alert-shaped something
 * the reader could not resolve, which no later quiet read may rewrite into proven absence.
 */
async function lookupTreeAlert<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
>(
  action: 'accept' | 'dismiss',
  driver: TreeAlertDriver<TCapture, TAlert, TButton, TCandidate, TPlatform>,
): Promise<{ kind: 'alert'; candidate: TCandidate }> {
  const lookup = await pollTreeAlert(driver, Deadline.fromTimeoutMs(ALERT_ACTION_RETRY_MS));
  const answer = lookup.settled
    ? lookup.value
    : lookup.sawUndecided
      ? ({ kind: 'undecided' } as const)
      : ({ kind: 'none' } as const);
  if (answer.kind !== 'alert') throw lookupRefusal(action, answer);
  return answer;
}

/**
 * The acting leg's confirm phase: `alert accept|dismiss` means the dialog is gone, not that a
 * press was sent, so only an observed absence or a different alert in its place settles the
 * leg. The confirm window is its own budget, started the moment the press lands; like the
 * lookup's, it ends its loop at the deadline and consumes the answer of every probe that
 * started inside it. Neither happened, so the "still visible" claim may only be made by the
 * latest capture that ANSWERED, and it must name this very dialog again — the freshest answer
 * said something else (or nothing), and all the leg may then report is the press
 * unconfirmed: the dialog may already be gone.
 */
async function confirmTreeAlertGone<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
>(
  driver: TreeAlertDriver<TCapture, TAlert, TButton, TCandidate, TPlatform>,
  dismissed: TAlert,
  action: 'accept' | 'dismiss',
): Promise<void> {
  const confirm = await pollTreeAlert(
    driver,
    Deadline.fromTimeoutMs(ALERT_ACTION_RETRY_MS),
    (observation) =>
      observation.kind === 'none' ||
      (observation.kind === 'alert' && !sameTreeAlert(observation.candidate.alert, dismissed)),
  );
  if (confirm.settled) return;
  if (confirm.value.kind === 'alert' && sameTreeAlert(confirm.value.candidate.alert, dismissed)) {
    throw visibleAfterPressFailure(action, dismissed);
  }
  throw new AppError(
    'COMMAND_FAILED',
    `alert ${action} pressed the button but the dismissal could not be confirmed`,
    {
      alert: dismissed,
      reason: ALERT_WINDOW_EXPIRED_REASON,
      hint: 'The alert button was pressed; the post-press checks never settled the dialog as gone, so it may already be gone. Run alert get --json before retrying.',
    },
  );
}

/**
 * What an unsettled lookup answers with: absence, or an alert-shaped capture no reader could
 * resolve. Both pressed nothing, and neither may be reported as the other.
 */
function lookupRefusal(
  action: 'accept' | 'dismiss',
  answer: { kind: 'none' } | { kind: 'undecided' },
): AppError {
  if (answer.kind === 'undecided') {
    return new AppError(
      'COMMAND_FAILED',
      `alert ${action} refused: the capture is alert-shaped but cannot be resolved to one alert`,
      {
        reason: ALERT_CAPTURE_UNDECIDED_REASON,
        dispatched: 'no',
        hint: 'Inspect alert get --json and snapshot -i, then press the visible choice by label/ref.',
      },
    );
  }
  return new AppError('COMMAND_FAILED', 'alert not found', {
    reason: ALERT_NOT_FOUND_REASON,
    dispatched: 'no',
    hint: ALERT_NOT_FOUND_HINT,
  });
}

/**
 * The stuck-alert failure: a post-press capture that answered named the same dialog again, so
 * the press did not dismiss what the latest completed read still saw on screen.
 */
function visibleAfterPressFailure<TAlert extends AlertInfo & { buttons: string[] }>(
  action: 'accept' | 'dismiss',
  dismissed: TAlert,
): AppError {
  return new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
    alert: dismissed,
    reason: ALERT_WINDOW_EXPIRED_REASON,
    hint: 'The alert button was pressed but the dialog was visible on the last check that answered. Inspect alert get --json, then press the visible button by label/ref or retry.',
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

/** The seam signal for a leg with no caller cancellation: nothing can cancel it. */
const neverSignal = new AbortController().signal;

function alertWindowMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' &&
    Number.isFinite(timeoutMs) &&
    timeoutMs >= 0 &&
    timeoutMs <= MAX_ALERT_WINDOW_MS
    ? timeoutMs
    : DEFAULT_ALERT_TIMEOUT_MS;
}
