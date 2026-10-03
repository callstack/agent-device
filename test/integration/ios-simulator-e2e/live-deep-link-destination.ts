import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

/** One destination wait; generous because the WebView lab took over 2.5 s to mount on cold CI. */
const DESTINATION_WAIT_MS = 15_000;
/**
 * The answered launch usually reaches the foreground within 3 s, but a loaded host held it for
 * 20.7 s (CI run 35991523779) and 27.4 s (a local run), and a relaunch can restart the runner,
 * whose start outlasts one wait.
 */
const DESTINATION_WAITS = 5;

/** Misses that say the destination was not observed yet, so another bounded wait may see it. */
const NOT_YET_OBSERVED: ReadonlySet<string | undefined> = new Set([
  WAIT_REASONS.deadlineExceeded,
  WAIT_REASONS.captureStalled,
  WAIT_REASONS.runnerRestartExhausted,
  WAIT_REASONS.readinessExhausted,
  WAIT_REASONS.targetAbsent,
]);

/** One destination wait; the final one is run without `allowFailure`, so its failure throws. */
export type DestinationWait = (
  step: string,
  options: { allowFailure: boolean },
) => Promise<CliJsonResult>;

/**
 * Waits for a deep-link route's own first landmark after `open` answered any launch confirmation.
 * Retries a miss that only says the destination was not observed yet, up to five 15 s waits;
 * any other failure fails at once.
 */
export async function waitForDeepLinkDestination(
  context: LiveContext,
  destination: readonly string[],
  options: { debug?: boolean } = {},
): Promise<CliJsonResult> {
  const arrived = await retryDestinationWait(
    async (step, { allowFailure }) =>
      await runStep(
        context,
        step,
        [
          'wait',
          ...destination,
          String(DESTINATION_WAIT_MS),
          ...(options.debug ? ['--debug'] : []),
        ],
        { allowFailure },
      ),
  );
  verifyCommand(
    context,
    PUBLIC_COMMANDS.wait,
    `wait observes the deep-link destination: ${destination.join(' ')}`,
  );
  return arrived;
}

export async function retryDestinationWait(wait: DestinationWait): Promise<CliJsonResult> {
  for (let attempt = 1; ; attempt += 1) {
    const arrived = await wait(
      `wait for the deep-link destination (${attempt}/${DESTINATION_WAITS})`,
      { allowFailure: attempt < DESTINATION_WAITS },
    );
    if (arrived.status === 0) return arrived;
    const reason = arrived.json?.error?.details?.reason;
    assert.ok(
      NOT_YET_OBSERVED.has(reason),
      `deep-link destination wait failed: ${JSON.stringify(arrived.json)}`,
    );
  }
}
