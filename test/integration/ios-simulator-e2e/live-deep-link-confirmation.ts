import assert from 'node:assert/strict';

import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep } from './live-harness.ts';

/** One destination wait; generous because the WebView lab took over 2.5 s to mount on cold CI. */
const DEEP_LINK_DESTINATION_WAIT_MS = '15000';
/**
 * One wait finds the confirmation holding the launch; three more cover the launch its answer
 * releases. That launch usually reaches the foreground within 3 s of the tap, but a loaded host has
 * held it for 20.7 s (CI run 35991523779) and 27.4 s (a local run), and the route renders after that.
 */
const DESTINATION_WAITS = 4;
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
): Promise<void> {
  return answerDeepLinkConfirmation({
    waitForDestination: (step) =>
      runStep(context, step, ['wait', ...destination, DEEP_LINK_DESTINATION_WAIT_MS], {
        allowFailure: true,
      }),
    inspectAlert: () =>
      runStep(context, 'inspect delayed deep-link system alert', ['alert', 'get'], {
        allowFailure: true,
      }),
    acceptAlert: () => runStep(context, 'accept deep-link confirmation', ['alert', 'accept']),
  });
}

/**
 * Only a destination wait that ends on `APP_NOT_RUNNING` — the launch is still pending — leads to
 * the alert probe or to another wait. Any other outcome returns, so an arrived route skips the probe
 * and a wrong route or a stalled capture fails on the caller's own destination assertion. The probe
 * therefore never queries a rendered screen, where `alert get` against a live WKWebView exceeds the
 * runner's execution watchdog and leaves later commands refused as `RUNNER_BUSY` (#2484 follow-up).
 */
export async function answerDeepLinkConfirmation(
  device: DeepLinkConfirmationDevice,
): Promise<void> {
  let answered = false;
  for (let wait = 1; wait <= DESTINATION_WAITS; wait += 1) {
    const arrived = await device.waitForDestination(
      `wait for the deep-link destination (${wait}/${DESTINATION_WAITS})`,
    );
    if (arrived.json?.error?.details?.runnerErrorCode !== APP_NOT_RUNNING) return;
    if (!answered) answered = await acceptOpenConfirmation(device);
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
