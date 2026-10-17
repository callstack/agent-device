import assert from 'node:assert/strict';
import test from 'node:test';

import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from './cli-json.ts';
import { retryDestinationWait } from './ios-simulator-e2e/live-deep-link-destination.ts';

function result(status: number, json?: unknown): CliJsonResult {
  return { json, status, stderr: '', stdout: '' };
}

function miss(details: Record<string, unknown>): CliJsonResult {
  return result(1, { error: { code: 'COMMAND_FAILED', retriable: true, details } });
}

const LANDED = result(0, { success: true });
const RUNNER_START_TIMEOUT = miss({
  reason: WAIT_REASONS.readinessExhausted,
  readinessPhase: 'runner-start',
});
const SLOW_FOREGROUND = miss({ reason: WAIT_REASONS.deadlineExceeded, readableCaptures: 5 });
const INVALID_SELECTOR = result(1, { error: { code: 'INVALID_ARGS' } });

/** Destination waits that answer in the order given; the final wait throws like `runStep`. */
function waits(answers: CliJsonResult[]) {
  const calls: Array<{ step: string; allowFailure: boolean }> = [];
  const wait = async (step: string, options: { allowFailure: boolean }) => {
    calls.push({ step, allowFailure: options.allowFailure });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    if (answer.status !== 0 && !options.allowFailure) throw new Error(`${step} failed`);
    return answer;
  };
  return { wait, calls };
}

test('a destination seen on the first wait costs one wait', async () => {
  const { wait, calls } = waits([LANDED]);
  assert.equal(await retryDestinationWait(wait), LANDED);
  assert.equal(calls.length, 1);
});

test('an observation prevented by runner startup gets one repeat', async () => {
  const { wait, calls } = waits([RUNNER_START_TIMEOUT, LANDED]);
  assert.equal(await retryDestinationWait(wait), LANDED);
  assert.deepEqual(
    calls.map((call) => call.allowFailure),
    [true, false],
  );
});

test('a readable destination miss fails without repeating the wait', async () => {
  const { wait, calls } = waits([SLOW_FOREGROUND, LANDED]);
  await assert.rejects(retryDestinationWait(wait), /deep-link destination wait failed/);
  assert.equal(calls.length, 1);
});

test('the second observation failure ends the wait', async () => {
  const { wait, calls } = waits([RUNNER_START_TIMEOUT]);
  await assert.rejects(retryDestinationWait(wait), /\(2\/2\) failed/);
  assert.equal(calls.length, 2);
});

test('the final failed result cannot start an unbounded wait if the caller returns it', async () => {
  let calls = 0;
  await assert.rejects(
    retryDestinationWait(async () => {
      calls += 1;
      return RUNNER_START_TIMEOUT;
    }),
    /deep-link destination wait failed/,
  );
  assert.equal(calls, 2);
});

test('a miss that is not a pending destination fails at once', async () => {
  const { wait, calls } = waits([INVALID_SELECTOR, LANDED]);
  await assert.rejects(retryDestinationWait(wait), /deep-link destination wait failed/);
  assert.equal(calls.length, 1);
});
