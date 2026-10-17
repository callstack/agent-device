import assert from 'node:assert/strict';

import {
  ALERT_NOT_FOUND_RUNNER_CODE,
  DEFAULT_ALERT_TIMEOUT_MS,
} from '@agent-device/contracts/alert-contract';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { isObservationPreventedStepMiss } from './live-step-retry-policy.ts';
import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

/** Allow the cold fixture route to mount before declaring a readable miss. */
const DESTINATION_WAIT_MS = 15_000;
// One repeat follows a prevented observation or the stopped-app confirmation branch.
const DESTINATION_WAITS = 2;

/** One destination wait; the final one is run without `allowFailure`, so its failure throws. */
export type DestinationWait = (
  step: string,
  options: { allowFailure: boolean },
) => Promise<CliJsonResult>;

/**
 * Observe the route before looking for a launch confirmation.
 * A typed stopped-app result permits explicit confirmation handling; readable misses fail.
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
    () =>
      answerFixtureLaunchConfirmation(
        () =>
          runStep(
            context,
            'wait for optional fixture launch confirmation',
            ['alert', 'wait', String(DEFAULT_ALERT_TIMEOUT_MS)],
            { allowFailure: true },
          ),
        () => runStep(context, 'accept fixture launch confirmation', ['alert', 'accept']),
      ),
  );
  verifyCommand(
    context,
    PUBLIC_COMMANDS.wait,
    `wait observes the deep-link destination: ${destination.join(' ')}`,
  );
  return arrived;
}

export async function retryDestinationWait(
  wait: DestinationWait,
  answerStoppedLaunch?: () => Promise<void>,
): Promise<CliJsonResult> {
  for (let attempt = 1; attempt <= DESTINATION_WAITS; attempt += 1) {
    const arrived = await wait(
      `wait for the deep-link destination (${attempt}/${DESTINATION_WAITS})`,
      { allowFailure: attempt < DESTINATION_WAITS },
    );
    if (arrived.status === 0) return arrived;
    if (
      attempt < DESTINATION_WAITS &&
      answerStoppedLaunch &&
      arrived.json?.error?.details?.runnerErrorCode === 'APP_NOT_RUNNING'
    ) {
      await answerStoppedLaunch();
      continue;
    }
    assert.ok(
      attempt < DESTINATION_WAITS && isObservationPreventedStepMiss(arrived),
      `deep-link destination wait failed: ${JSON.stringify(arrived.json)}`,
    );
  }
  throw new Error('deep-link destination observation exhausted');
}

/** The fixture owns this scheme; only its exact English launch confirmation may be answered. */
export async function answerFixtureLaunchConfirmation(
  read: () => Promise<CliJsonResult>,
  accept: () => Promise<unknown>,
): Promise<void> {
  const result = await read();
  if (result.status !== 0) {
    assert.equal(
      result.json?.error?.details?.runnerErrorCode,
      ALERT_NOT_FOUND_RUNNER_CODE,
      `launch confirmation observation failed: ${JSON.stringify(result.json)}`,
    );
    return;
  }
  assert.equal(result.json?.data?.message, 'Open in “Agent Device Tester”?');
  assert.deepEqual(result.json?.data?.items, ['Cancel', 'Open']);
  await accept();
}
