import assert from 'node:assert/strict';

import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { isObservationPreventedStepMiss } from './live-step-retry-policy.ts';
import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

/** One destination wait; generous because the WebView lab took over 2.5 s to mount on cold CI. */
const DESTINATION_WAIT_MS = 15_000;
// One repeat is allowed only when the runtime could not make an observation.
const DESTINATION_WAITS = 2;

/** One destination wait; the final one is run without `allowFailure`, so its failure throws. */
export type DestinationWait = (
  step: string,
  options: { allowFailure: boolean },
) => Promise<CliJsonResult>;

/**
 * Waits for a deep-link route's own first landmark after `open` answered any launch confirmation.
 * Repeats only a typed, retriable observation failure. A readable miss fails immediately.
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
        { allowFailure, reattemptInfrastructureMiss: undefined },
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
  for (let attempt = 1; attempt <= DESTINATION_WAITS; attempt += 1) {
    const arrived = await wait(
      `wait for the deep-link destination (${attempt}/${DESTINATION_WAITS})`,
      { allowFailure: attempt < DESTINATION_WAITS },
    );
    if (arrived.status === 0) return arrived;
    assert.ok(
      attempt < DESTINATION_WAITS && isObservationPreventedStepMiss(arrived),
      `deep-link destination wait failed: ${JSON.stringify(arrived.json)}`,
    );
  }
  throw new Error('deep-link destination observation exhausted');
}
