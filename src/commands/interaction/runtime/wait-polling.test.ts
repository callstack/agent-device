import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceRuntime } from '../../../runtime-contract.ts';
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
  const polling = createWaitPolling(runtime, {}, 125);

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
    );
    const sleeping = polling.sleepUntilNextPoll();

    const reason = new Error(`${authority} canceled`);
    (authority === 'runtime' ? runtimeController : commandController).abort(reason);

    await assert.rejects(sleeping, reason);
  }
});
