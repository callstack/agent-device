import assert from 'node:assert/strict';
import test from 'node:test';

import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from './cli-json.ts';
import { isObservationPreventedStepMiss } from './ios-simulator-e2e/live-step-retry-policy.ts';

// The #2491 retry policy for the iOS live lane, pinned without a simulator: which typed wire
// verdicts the lane may re-issue one step for, and — the closest negatives — which look close but
// must fail at once. The pairing of `retriable: true` with an observation-prevented
// `details.reason` is the whole predicate; neither signal alone activates a re-issue.

function stepResult(json: unknown, status = 1): CliJsonResult {
  return { json, status, stdout: '', stderr: '' };
}

function waitFailure(reason: string, retriable: boolean | undefined): CliJsonResult {
  return stepResult({
    error: {
      code: 'COMMAND_FAILED',
      details: { reason },
      ...(retriable === undefined ? {} : { retriable }),
    },
  });
}

for (const reason of [
  WAIT_REASONS.captureStalled,
  WAIT_REASONS.runnerRestartExhausted,
  WAIT_REASONS.readinessExhausted,
]) {
  test(`${reason} with the product's retriable verdict re-issues the step`, () => {
    assert.equal(isObservationPreventedStepMiss(waitFailure(reason, true)), true);
  });
}

test('an observation-prevented reason without the product retriable verdict does not re-issue', () => {
  // The negative that keeps the predicate keyed on the conjunction: a response carrying the same
  // reason but marked non-retriable (or carrying no verdict) must not buy a re-issue.
  assert.equal(
    isObservationPreventedStepMiss(waitFailure(WAIT_REASONS.captureStalled, false)),
    false,
  );
  assert.equal(
    isObservationPreventedStepMiss(waitFailure(WAIT_REASONS.captureStalled, undefined)),
    false,
  );
});

test('a retriable target-absent or deadline-exceeded wait does not re-issue', () => {
  // The screen was readable: the target was not there, or a readable capture consumed the
  // remaining budget. Re-issuing would hide a real absence, so these stay hard failures.
  assert.equal(isObservationPreventedStepMiss(waitFailure(WAIT_REASONS.targetAbsent, true)), false);
  assert.equal(
    isObservationPreventedStepMiss(waitFailure(WAIT_REASONS.deadlineExceeded, true)),
    false,
  );
});

test('a non-wait retriable failure does not re-issue', () => {
  // A retriable verdict on a response with no wait taxonomy reason (e.g. a leased-busy device on
  // a click) is not evidence that observation of THIS step was prevented.
  assert.equal(
    isObservationPreventedStepMiss(
      stepResult({ error: { code: 'DEVICE_IN_USE', retriable: true } }),
    ),
    false,
  );
});

test('a successful step result is never a re-attributable miss', () => {
  assert.equal(isObservationPreventedStepMiss(stepResult(undefined, 0)), false);
  assert.equal(isObservationPreventedStepMiss(stepResult(undefined)), false);
});
