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
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
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

export type TreeAlertSleep = (milliseconds: number) => Promise<void>;

/**
 * The seams one tree-based backend owns. `timeoutMs` bounds `wait`; the acting legs ride the
 * contract action budget. The sleep seam exists so tests advance polls on a driven clock
 * (`docs/agents/testing.md`) instead of production time.
 */
export type TreeAlertDriver<
  TCapture,
  TAlert extends AlertInfo & { buttons: string[] },
  TButton extends TreeAlertButton,
  TCandidate extends TreeAlertCandidate<TAlert, TButton>,
  TPlatform extends AlertPlatform,
> = Readonly<{
  platform: TPlatform;
  timeoutMs?: number;
  sleep?: TreeAlertSleep;
  capture: () => Promise<TCapture>;
  findCandidate: (capture: TCapture) => TreeAlertObservation<TCandidate>;
  choose: (candidate: TCandidate, action: 'accept' | 'dismiss') => TreeAlertPress<TButton> | null;
  press: (choice: TreeAlertPress<TButton>) => Promise<void>;
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
  const nap = driver.sleep ?? sleep;
  const observe: TreeAlertObserver<TCandidate> = async () =>
    driver.findCandidate(await driver.capture());
  if (action === 'get') {
    return buildTreeAlertStatusResponse(driver.platform, await observe());
  }
  if (action === 'wait') {
    const start = Date.now();
    const polled = await pollTreeAlert(observe, alertWindowMs(driver.timeoutMs), nap);
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
  return await actOnTreeAlert(action, driver, observe, nap);
}

function alertWindowMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : DEFAULT_ALERT_TIMEOUT_MS;
}

/**
 * Polls for an actionable candidate within the budget. The terminal answer distinguishes a
 * window that stayed quiet (`none`) from one that stayed alert-shaped yet unresolvable
 * (`undecided`): a degraded sheet that never resolved is not an absence, and callers must not
 * report the two alike.
 */
async function pollTreeAlert<TCandidate>(
  observe: TreeAlertObserver<TCandidate>,
  timeoutMs: number,
  nap: TreeAlertSleep,
): Promise<TreeAlertObservation<TCandidate>> {
  const start = Date.now();
  let sawUndecided = false;
  for (;;) {
    const observation = await observe();
    if (observation.kind === 'alert') return observation;
    if (observation.kind === 'undecided') sawUndecided = true;
    if (Date.now() - start >= timeoutMs) {
      return sawUndecided ? { kind: 'undecided' } : { kind: 'none' };
    }
    await nap(ALERT_POLL_INTERVAL_MS);
  }
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
  observe: TreeAlertObserver<TCandidate>,
  nap: TreeAlertSleep,
): Promise<TreeAlertResult<TAlert, TPlatform>> {
  const polled = await pollTreeAlert(observe, ALERT_ACTION_RETRY_MS, nap);
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
  await driver.press(choice);
  await confirmTreeAlertDismissed(observe, candidate.alert, action, nap);
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
  dismissed: TAlert,
  action: 'accept' | 'dismiss',
  nap: TreeAlertSleep,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const observation = await observe();
    if (observation.kind === 'none') return;
    if (observation.kind === 'alert' && !sameTreeAlert(observation.candidate.alert, dismissed)) {
      return;
    }
    if (Date.now() - start >= ALERT_ACTION_RETRY_MS) {
      throw new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
        alert: dismissed,
        hint: 'The alert button was pressed but the dialog is still visible. Inspect alert get --json, then press the visible button by label/ref or retry.',
      });
    }
    await nap(ALERT_POLL_INTERVAL_MS);
  }
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
  captureNodes: () => Promise<RawSnapshotNode[]>;
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
    capture: () =>
      withDiagnosticTimer('snapshot_capture', options.captureNodes, {
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
    press: async (choice) => {
      if (choice.kind === 'press') {
        await pressAndroid(device, choice.button.x, choice.button.y);
        return;
      }
      await backAndroid(device);
    },
  });
}
