import assert from 'node:assert/strict';

import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep } from './live-harness.ts';

/** One destination wait; generous because the WebView lab took over 2.5 s to mount on cold CI. */
const DEEP_LINK_DESTINATION_WAIT_MS = '15000';
/**
 * One wait can find the confirmation holding the launch; four more cover its release or a stalled
 * runner restart. The answered launch usually reaches the foreground within 3 s, but a loaded host
 * held it for 20.7 s (CI run 35991523779) and 27.4 s (a local run).
 */
const DESTINATION_WAITS = 5;
/** `details.runnerErrorCode` of a read the runner refused because the session app is not running. */
const APP_NOT_RUNNING = 'APP_NOT_RUNNING';

export type DeepLinkConfirmationDevice = {
  waitForDestination: (step: string) => Promise<CliJsonResult>;
  inspectAlert: () => Promise<CliJsonResult>;
  acceptAlert: () => Promise<unknown>;
};

/**
 * iOS can hold a custom-scheme deep link behind an "Open in <app>?" confirmation. `destination` is
 * the `wait` predicate for the route's own first landmark, a native node the route renders before
 * its content.
 */
export function acceptDeepLinkConfirmationIfPresent(
  context: LiveContext,
  destination: readonly string[],
  options: { debug?: boolean } = {},
): Promise<void> {
  return answerDeepLinkConfirmation({
    waitForDestination: (step) =>
      runStep(
        context,
        step,
        [
          'wait',
          ...destination,
          DEEP_LINK_DESTINATION_WAIT_MS,
          ...(options.debug ? ['--debug'] : []),
        ],
        { allowFailure: true },
      ),
    inspectAlert: () =>
      runStep(context, 'inspect delayed deep-link system alert', ['alert', 'get'], {
        allowFailure: true,
      }),
    acceptAlert: () => runStep(context, 'accept deep-link confirmation', ['alert', 'accept']),
  });
}

/**
 * A readable destination timeout can still leave the launch behind a system confirmation. Probe
 * once per miss until it is answered; a truncated or stalled capture then gets another bounded
 * wait, while a readable wrong-route miss without a prompt goes to the caller's assertion.
 */
export async function answerDeepLinkConfirmation(
  device: DeepLinkConfirmationDevice,
): Promise<void> {
  let answered = false;
  for (let wait = 1; wait <= DESTINATION_WAITS; wait += 1) {
    const arrived = await device.waitForDestination(
      `wait for the deep-link destination (${wait}/${DESTINATION_WAITS})`,
    );
    if (arrived.status === 0) return;
    const details = arrived.json?.error?.details;
    const launchPending = details?.runnerErrorCode === APP_NOT_RUNNING;
    const reason = details?.reason;
    const readableMiss =
      reason === WAIT_REASONS.targetAbsent || reason === WAIT_REASONS.deadlineExceeded;
    const interruptedCapture =
      reason === WAIT_REASONS.captureStalled || reason === WAIT_REASONS.runnerRestartExhausted;
    if (!launchPending && !readableMiss && !interruptedCapture) return;
    if (!answered) answered = await acceptOpenConfirmation(device);
    if (!answered && reason === WAIT_REASONS.targetAbsent) return;
  }
}

async function acceptOpenConfirmation(device: DeepLinkConfirmationDevice): Promise<boolean> {
  const alert = await device.inspectAlert();
  if (alert.status !== 0) return false;
  const alertInfo = alert.json?.data;
  assert.match(String(alertInfo?.message), /^Open in\b/, JSON.stringify(alert.json));
  assert.ok(
    Array.isArray(alertInfo?.items) && alertInfo.items.includes('Open'),
    JSON.stringify(alert.json),
  );
  await device.acceptAlert();
  return true;
}
