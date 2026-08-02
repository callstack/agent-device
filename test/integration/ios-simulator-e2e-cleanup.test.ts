import assert from 'node:assert/strict';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import { retryCleanupStep } from './ios-simulator-e2e/live-harness.ts';

// Deterministic regression for the retry/guard policy behind #1548: a full-tier iOS
// e2e run's cleanup must tolerate a dead session and the known appless mic-permission
// reset without swallowing an unrelated failure. `retryCleanupStep` runs the exact
// per-step policy `cleanupSession` uses, driven here by a scripted `runAttempt` instead
// of the real CLI subprocess, so these cases run in milliseconds with no simulator.

const MIC_STEP = 'reset microphone permission';
const OTHER_STEP = 'restore portrait orientation';
const MIC_APPLESS_MESSAGE = 'permission setting requires an active app in session';

function invalidArgsResult(message: string): CliJsonResult {
  return { json: { error: { code: 'INVALID_ARGS', message } }, status: 1, stderr: '', stdout: '' };
}

function sessionNotFoundResult(): CliJsonResult {
  return {
    json: { error: { code: 'SESSION_NOT_FOUND', message: 'No active session' } },
    status: 1,
    stderr: '',
    stdout: '',
  };
}

// retryCleanupStep sleeps 500ms between attempts. Drive fake timers instead of waiting
// real time: repeatedly flush the microtask queue and advance the mocked clock until
// the retry promise settles.
async function drainRetry(
  t: { mock: { timers: { tick: (ms: number) => void } } },
  promise: Promise<unknown>,
): Promise<unknown> {
  let settled = false;
  promise.finally(() => {
    settled = true;
  });
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(500);
  }
  return promise;
}

test('a dead session (SESSION_NOT_FOUND) skips cleanup without error, on any step', async () => {
  let attempts = 0;
  const failure = await retryCleanupStep(MIC_STEP, async () => {
    attempts += 1;
    return sessionNotFoundResult();
  });
  assert.equal(failure, undefined);
  assert.equal(attempts, 1, 'should not retry once the session is confirmed gone');
});

test('the known mic-permission appless response stops retrying immediately', async () => {
  let attempts = 0;
  const failure = await retryCleanupStep(MIC_STEP, async () => {
    attempts += 1;
    return invalidArgsResult(MIC_APPLESS_MESSAGE);
  });
  assert.equal(failure, undefined);
  assert.equal(attempts, 1, 'should not retry the known appless response');
});

test('a different INVALID_ARGS still fails after exhausting retries', async (t) => {
  // Same message, wrong step: proves the guard is scoped to the mic-permission reset
  // and does not tolerate the identical string on another step.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const failure = await drainRetry(
    t,
    retryCleanupStep(OTHER_STEP, async (attempt) => {
      attempts += 1;
      if (attempt < 3) return invalidArgsResult(MIC_APPLESS_MESSAGE);
      // Mirrors runStep(..., { allowFailure: false }) on the final attempt: it throws
      // instead of returning a failed result.
      throw new Error(`cleanup: ${OTHER_STEP} (attempt 3) failed`);
    }),
  );
  assert.ok(failure instanceof Error, `expected a propagated failure, got ${String(failure)}`);
  assert.equal(attempts, 3, 'should exhaust all three attempts');
});

test('a different INVALID_ARGS message on the mic-permission step still fails after retries', async (t) => {
  // Same step, a message sharing the "requires an active app in session" suffix with
  // the location-setting call site (app-settings.ts): proves the match is the exact
  // known string, not any INVALID_ARGS message that happens to overlap it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const failure = await drainRetry(
    t,
    retryCleanupStep(MIC_STEP, async (attempt) => {
      attempts += 1;
      if (attempt < 3)
        return invalidArgsResult('location setting requires an active app in session');
      throw new Error(`cleanup: ${MIC_STEP} (attempt 3) failed`);
    }),
  );
  assert.ok(failure instanceof Error, `expected a propagated failure, got ${String(failure)}`);
  assert.equal(attempts, 3, 'should exhaust all three attempts');
});
