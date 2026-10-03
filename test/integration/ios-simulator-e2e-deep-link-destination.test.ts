import assert from 'node:assert/strict';
import test from 'node:test';

import { WAIT_REASONS } from '@agent-device/contracts/wait';
import type { CliJsonResult } from './cli-json.ts';
import { retryDestinationWait } from './ios-simulator-e2e/live-deep-link-destination.ts';

function result(status: number, json?: unknown): CliJsonResult {
  return { json, status, stderr: '', stdout: '' };
}

function miss(details: Record<string, unknown>): CliJsonResult {
  return result(1, { error: { code: 'COMMAND_FAILED', details } });
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

test('a runner start and a slow foreground are waited out within the bounded waits', async () => {
  const { wait, calls } = waits([RUNNER_START_TIMEOUT, SLOW_FOREGROUND, LANDED]);
  assert.equal(await retryDestinationWait(wait), LANDED);
  assert.deepEqual(
    calls.map((call) => call.allowFailure),
    [true, true, true],
  );
});

test('the fifth miss fails the wait instead of retrying again', async () => {
  const { wait, calls } = waits([SLOW_FOREGROUND]);
  await assert.rejects(retryDestinationWait(wait), /\(5\/5\) failed/);
  assert.equal(calls.length, 5);
  assert.equal(calls.at(-1)?.allowFailure, false);
});

test('a miss that is not a pending destination fails at once', async () => {
  const { wait, calls } = waits([INVALID_SELECTOR, LANDED]);
  await assert.rejects(retryDestinationWait(wait), /deep-link destination wait failed/);
  assert.equal(calls.length, 1);
});
