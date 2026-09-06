import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import { createWaitPolling } from './wait-polling.ts';

test('poll delay is bounded by the remaining wait budget', async () => {
  let currentMs = 0;
  const sleeps: number[] = [];
  const runtime = {
    clock: {
      now: () => currentMs,
      sleep: async (durationMs: number) => {
        sleeps.push(durationMs);
        currentMs += durationMs;
      },
    },
  } as AgentDeviceRuntime;
  const polling = createWaitPolling(runtime, {}, 125, SELECTOR_PIPELINE_POLICIES.wait);

  assert.equal(await polling.sleepUntilNextPoll(), true);
  assert.deepEqual(sleeps, [125]);
  assert.equal(polling.hasTimeRemaining(), false);
});

test('poll delay observes both runtime and command cancellation', async () => {
  for (const authority of ['runtime', 'command'] as const) {
    const runtimeController = new AbortController();
    const commandController = new AbortController();
    const polling = createWaitPolling(
      { signal: runtimeController.signal } as AgentDeviceRuntime,
      { signal: commandController.signal },
      10_000,
      SELECTOR_PIPELINE_POLICIES.wait,
    );
    const sleeping = polling.sleepUntilNextPoll();

    const reason = new Error(`${authority} canceled`);
    (authority === 'runtime' ? runtimeController : commandController).abort(reason);

    await assert.rejects(sleeping, reason);
  }
});

test('failure evidence carries every poll on the wait clock with its typed outcome', async () => {
  let currentMs = 0;
  const runtime = {
    clock: { now: () => currentMs, sleep: async (_durationMs: number) => {} },
  } as AgentDeviceRuntime;
  const unreadable = new Error('content verdict');
  const polling = createWaitPolling(runtime, {}, 60, SELECTOR_PIPELINE_POLICIES.wait, {
    isUnreadableError: (error) => error === unreadable,
  });

  await polling.capture(async () => {
    currentMs += 20;
    return 'seen';
  });
  await polling.capture(async () => {
    currentMs += 10;
    throw unreadable;
  });
  // The third capture outlives the remaining real-time budget: the deadline cancels it.
  const last = await polling.capture(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    currentMs += 40;
    return 'late';
  });

  assert.equal(last.timedOut, true);
  const evidence = polling.failureEvidence();
  assert.equal(evidence.captures, 3);
  assert.equal(evidence.readableCaptures, 1);
  assert.deepEqual(evidence.polls, [
    { startedMs: 0, durationMs: 20, outcome: 'readable' },
    { startedMs: 20, durationMs: 10, outcome: 'unreadable' },
    { startedMs: 30, durationMs: 40, outcome: 'deadline' },
  ]);
});

test('a long wait keeps its first polls and its last polls in the failure evidence', async () => {
  let currentMs = 0;
  const runtime = {
    clock: { now: () => currentMs, sleep: async (_durationMs: number) => {} },
  } as AgentDeviceRuntime;
  const polling = createWaitPolling(runtime, {}, 100_000, SELECTOR_PIPELINE_POLICIES.wait);
  for (let index = 0; index < 40; index += 1) {
    await polling.capture(async () => {
      currentMs += 100;
      return index;
    });
  }

  const evidence = polling.failureEvidence();
  assert.equal(evidence.captures, 40);
  assert.equal(evidence.polls.length, 30);
  assert.equal(evidence.polls[0]?.startedMs, 0);
  assert.equal(evidence.polls[4]?.startedMs, 400);
  assert.equal(evidence.polls[5]?.startedMs, 1_500);
  assert.equal(evidence.polls.at(-1)?.startedMs, 3_900);
});
