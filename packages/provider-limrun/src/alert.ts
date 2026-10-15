import {
  ALERT_ACTION_RETRY_MS,
  ALERT_POLL_INTERVAL_MS,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import { successText } from '@agent-device/kernel/success-text';
import type { InstanceClient as LimrunIosClient } from '@limrun/api/ios-client';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  chooseLimrunAlertButton,
  findLimrunAlertCandidate,
  type LimrunAlertCandidate,
  type LimrunAlertInfo,
} from './alert-detection.ts';

/**
 * The four alert legs on a Limrun iOS direct session (issue #3349). There is no XCUITest runner
 * to ask, so the legs observe through the session's own element-tree capture and act through the
 * same point-touch seam every other touch operation rides. The response records match the
 * Android tree-based legs' `alertStatus`/`alertWait`/`alertHandled` kinds, which is the shape the
 * daemon composes CLI and SDK output around.
 */

/** The client methods the legs use; declared here so the legs are testable without a live instance. */
export type LimrunIosAlertClient = Readonly<{
  elementTree: LimrunIosClient['elementTree'];
  tap: LimrunIosClient['tap'];
}>;

/** Tests pass a zero-wait sleep; production rides the timer. */
export type LimrunAlertSleep = (milliseconds: number) => Promise<void>;

const realSleep: LimrunAlertSleep = async (milliseconds) => {
  await sleep(milliseconds);
};

export type LimrunIosAlertResult =
  | {
      kind: 'alertStatus';
      platform: 'ios';
      action: 'get';
      alert: LimrunAlertInfo | null;
      message?: string;
    }
  | {
      kind: 'alertWait';
      platform: 'ios';
      action: 'wait';
      alert: LimrunAlertInfo;
      waitedMs: number;
      message?: string;
    }
  | {
      kind: 'alertHandled';
      platform: 'ios';
      action: 'accept' | 'dismiss';
      handled: true;
      alert: LimrunAlertInfo;
      button: string;
      coordinates: { x: number; y: number };
      message?: string;
    };

export type LimrunIosAlertAction = 'get' | 'wait' | 'accept' | 'dismiss';

const ALERT_NOT_FOUND_HINT =
  'If the sheet is visible in snapshot but alert reports no alert, it is likely app-owned UI. Use snapshot -i and press the visible label/ref.';

/** A malformed window must fail as an immediate timeout, never as a loop whose bound is never reached. */
function alertTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : fallback;
}

export async function handleLimrunIosAlert(
  client: LimrunIosAlertClient,
  action: LimrunIosAlertAction,
  options?: Readonly<{
    timeoutMs?: number;
    /** Tests advance polls without waiting production time (`docs/agents/testing.md`). */
    sleep?: LimrunAlertSleep;
  }>,
): Promise<LimrunIosAlertResult> {
  const nap = options?.sleep ?? realSleep;
  if (action === 'get') {
    const candidate = await readLimrunAlertCandidate(client);
    return {
      kind: 'alertStatus',
      platform: 'ios',
      action: 'get',
      alert: candidate?.alert ?? null,
      ...(candidate ? successText('Alert visible') : successText('No alert visible')),
    };
  }
  if (action === 'wait') {
    const start = Date.now();
    const candidate = await pollLimrunAlertCandidate(
      client,
      alertTimeoutMs(options?.timeoutMs, DEFAULT_ALERT_TIMEOUT_MS),
      nap,
    );
    if (!candidate) {
      throw new AppError('COMMAND_FAILED', 'alert wait timed out');
    }
    return {
      kind: 'alertWait',
      platform: 'ios',
      action: 'wait',
      alert: candidate.alert,
      waitedMs: Date.now() - start,
      ...successText('Alert visible'),
    };
  }
  return await actOnLimrunIosAlert(client, action, nap);
}

/**
 * Accept and dismiss share the Android legs' contract: look within the action budget, press
 * exactly the one button the action's label vocabulary names, then confirm the alert is gone.
 * `dismiss` never authorizes anything — an alert whose denying choice cannot be named is
 * reported as the ambiguity it is instead of pressing something.
 */
async function actOnLimrunIosAlert(
  client: LimrunIosAlertClient,
  action: 'accept' | 'dismiss',
  nap: LimrunAlertSleep,
): Promise<LimrunIosAlertResult> {
  const candidate = await pollLimrunAlertCandidate(client, ALERT_ACTION_RETRY_MS, nap);
  if (!candidate) {
    throw new AppError('COMMAND_FAILED', 'alert not found', { hint: ALERT_NOT_FOUND_HINT });
  }
  const button = chooseLimrunAlertButton(candidate.buttons, action);
  if (!button) {
    throw new AppError(
      'COMMAND_FAILED',
      `alert ${action} found an alert but no button that clearly matches the action`,
      {
        alert: candidate.alert,
        hint: 'Inspect alert get --json for the visible buttons, then press the choice you want by label/ref.',
      },
    );
  }
  await client.tap(button.x, button.y);
  await confirmLimrunAlertDismissed(client, candidate, action, nap);
  return {
    kind: 'alertHandled',
    platform: 'ios',
    action,
    handled: true,
    alert: candidate.alert,
    button: button.label,
    coordinates: { x: button.x, y: button.y },
    ...successText(`Alert ${action}ed`),
  };
}

/**
 * `alert accept|dismiss` means the dialog is gone, not that a tap was sent: the next command
 * reads the app, and an alert still up would be read as the app's state. A different alert
 * taking its place counts as dismissed, the same as the Android legs accept.
 */
async function confirmLimrunAlertDismissed(
  client: LimrunIosAlertClient,
  dismissed: LimrunAlertCandidate,
  action: 'accept' | 'dismiss',
  nap: LimrunAlertSleep,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const current = await readLimrunAlertCandidate(client);
    if (!current || !sameLimrunAlert(current.alert, dismissed.alert)) return;
    if (Date.now() - start >= ALERT_ACTION_RETRY_MS) {
      throw new AppError('COMMAND_FAILED', `alert ${action} did not dismiss the visible alert`, {
        alert: dismissed.alert,
        hint: 'The alert button was pressed but the dialog is still visible. Inspect alert get --json, then press the visible button by label/ref or retry.',
      });
    }
    await nap(ALERT_POLL_INTERVAL_MS);
  }
}

function sameLimrunAlert(left: LimrunAlertInfo, right: LimrunAlertInfo): boolean {
  return left.title === right.title && left.buttons.join('\u0000') === right.buttons.join('\u0000');
}

async function pollLimrunAlertCandidate(
  client: LimrunIosAlertClient,
  timeoutMs: number,
  nap: LimrunAlertSleep,
): Promise<LimrunAlertCandidate | null> {
  const start = Date.now();
  for (;;) {
    const candidate = await readLimrunAlertCandidate(client);
    if (candidate) return candidate;
    if (Date.now() - start >= timeoutMs) return null;
    await nap(ALERT_POLL_INTERVAL_MS);
  }
}

async function readLimrunAlertCandidate(
  client: LimrunIosAlertClient,
): Promise<LimrunAlertCandidate | null> {
  return findLimrunAlertCandidate(await client.elementTree());
}
