import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

vi.mock('../core/runner-client.ts', () => ({ runAppleRunnerCommand: vi.fn() }));
vi.mock('../os/macos/helper.ts', () => ({ runMacOsAlertAction: vi.fn() }));

import {
  ALERT_MIN_READ_BUDGET_MS,
  ALERT_NOT_FOUND_REASON,
  ALERT_RUNNER_MAX_BUDGET_MS,
  DEFAULT_ALERT_TIMEOUT_MS,
  ALERT_NOT_FOUND_RUNNER_CODE,
  ALERT_WAIT_TIMEOUT_REASON,
  ALERT_POLL_INTERVAL_MS,
  ALERT_UNRESOLVED_RUNNER_CODE,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { runMacOsAlertAction } from '../os/macos/helper.ts';
import { actOnAppleAlert, alertIfPresent, awaitAppleAlert, readAppleAlert } from '../alert.ts';

const mockRunner = vi.mocked(runAppleRunnerCommand);
const mockHelper = vi.mocked(runMacOsAlertAction);
const runnerOptions = {};

/**
 * Absence as each backend states it. The message is deliberately the same prose the old predicate
 * matched on, so a test that passes here is passing on the typed evidence and nothing else.
 */
function runnerAbsence(): AppError {
  return new AppError('COMMAND_FAILED', 'alert not found', {
    runnerErrorCode: ALERT_NOT_FOUND_RUNNER_CODE,
  });
}

/** A system prompt the runner saw but could not read, as the runner contract classifies it. */
function runnerUnresolved(): AppError {
  return new AppError(ALERT_UNRESOLVED_RUNNER_CODE, 'a system prompt is visible', {
    runnerErrorCode: ALERT_UNRESOLVED_RUNNER_CODE,
    dispatched: 'no',
    hint: 'Inspect it with screenshot, then snapshot -i.',
  });
}

function helperAbsence(): AppError {
  return new AppError('COMMAND_FAILED', 'alert not found', { reason: ALERT_NOT_FOUND_REASON });
}

afterEach(() => {
  vi.useRealTimers();
  mockRunner.mockReset();
  mockHelper.mockReset();
});

// R59 moved these windows out of the daemon: how long a transient sheet takes to appear, and how
// many times to re-ask a runner that says it is not there yet, are Apple family mechanics.
test.each([
  ['the caller window', 3_000, 3_000],
  ['no window', undefined, DEFAULT_ALERT_TIMEOUT_MS],
  ['a window below the floor', 37, ALERT_MIN_READ_BUDGET_MS],
  ['a window above the ceiling', 60_000, ALERT_RUNNER_MAX_BUDGET_MS],
])('a read spends %s as the runner budget', async (_label, timeoutMs, budgetMs) => {
  mockRunner.mockResolvedValue({ title: 'Camera Access' });

  await readAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    timeoutMs === undefined ? {} : { timeoutMs },
    process.env,
  );

  assert.equal(mockRunner.mock.calls.length, 1);
  assert.deepEqual(mockRunner.mock.calls[0]?.[1], {
    command: 'alert',
    action: 'get',
    appBundleId: undefined,
    timeoutMs: budgetMs,
  });
});

test('a read cut off by the runner watchdog is reported as itself, never as absence', async () => {
  const watchdog = new AppError('COMMAND_FAILED', 'runner main thread timed out', {
    runnerErrorCode: 'MAIN_THREAD_TIMEOUT',
    reason: 'runner_main_thread_timeout',
    dispatched: 'unknown',
  });
  mockRunner.mockRejectedValue(watchdog);

  await assert.rejects(
    alertIfPresent(readAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 3_000 }, process.env)),
    (error: unknown) => error === watchdog,
  );
  assert.equal(mockRunner.mock.calls.length, 1);
});

test('a wait window above the ceiling is polled in runner attempts within the ceiling', async () => {
  mockRunner.mockResolvedValue({ title: 'Camera Access' });

  await awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 120_000 }, process.env);

  assert.equal(
    (mockRunner.mock.calls[0]?.[1] as { timeoutMs: number } | undefined)?.timeoutMs,
    ALERT_RUNNER_MAX_BUDGET_MS,
  );
});

test('a wait polls until one attempt answers, and the first attempt gets the whole window', async () => {
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw runnerAbsence();
    return { title: 'Camera Access' };
  });

  const result = await awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 5_000 },
    process.env,
  );

  assert.deepEqual(result, { title: 'Camera Access' });
  assert.equal(calls, 2);
  const budgets = mockRunner.mock.calls.map((call) => (call[1] as { timeoutMs: number }).timeoutMs);
  assert.equal(budgets[0], 5_000);
  // Later attempts get only what is left, so a blocking runner cannot outlive the budget.
  assert.ok(budgets[1] !== undefined && budgets[1] <= 5_000);
});

test('a wait that never sees an alert reports the timeout rather than the last attempt error', async () => {
  vi.useFakeTimers();
  mockRunner.mockRejectedValue(runnerAbsence());

  const outcome = awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 900 },
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(2_000);

  assert.equal(((await outcome) as AppError).details?.reason, ALERT_WAIT_TIMEOUT_REASON);
});

test('an accept retries only while the backend says the alert is not there yet', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', 'runner crashed');
  });

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);

  assert.match(String(((await outcome) as Error).message), /runner crashed/);
  assert.equal(calls, 1);
});

test('an exhausted accept carries the scoped-snapshot fallback the agent needs next', async () => {
  vi.useFakeTimers();
  mockRunner.mockRejectedValue(runnerAbsence());

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.equal(error.message, 'alert not found');
  assert.match(String(error.details?.hint), /scoped snapshot/i);
});

test('an action gives every retry at least the minimum read budget', async () => {
  vi.useFakeTimers();
  mockRunner.mockRejectedValue(runnerAbsence());

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);

  await outcome;
  const budgets = mockRunner.mock.calls.map((call) => (call[1] as { timeoutMs: number }).timeoutMs);
  assert.ok(budgets.length >= 2, 'the act loop never retried');
  for (const budget of budgets.slice(1)) {
    assert.ok(budget >= ALERT_MIN_READ_BUDGET_MS, `retry started with only ${budget} ms`);
  }
});

test('a runner action still reaches a prompt that appears 0.8 s into its window', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  mockRunner.mockImplementation(async () => {
    if (Date.now() - start < 800) throw runnerAbsence();
    return { accepted: true };
  });

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    (value) => value,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);

  assert.deepEqual(await outcome, { accepted: true });
  const lastRead = mockRunner.mock.calls.at(-1)?.[1] as { timeoutMs: number };
  assert.ok(lastRead.timeoutMs >= ALERT_MIN_READ_BUDGET_MS);
});

test('a slow first action read still retries within the two-second window', async () => {
  vi.useFakeTimers();
  mockRunner.mockImplementation(async () => {
    if (mockRunner.mock.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      throw runnerAbsence();
    }
    return { accepted: true };
  });

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    (value) => value,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);

  assert.deepEqual(await outcome, { accepted: true });
  assert.equal(mockRunner.mock.calls.length, 2);
  const retryCall = mockRunner.mock.calls[1];
  assert.ok(retryCall);
  const retry = retryCall[1] as { timeoutMs: number };
  assert.equal(retry.timeoutMs, ALERT_MIN_READ_BUDGET_MS);
});

// The whole point of typing absence: a backend that failed for any other reason must not be
// retried until the window expires and then reported as a timeout. These three pin that the
// evidence — not the message text — is what decides.
test('a wait propagates a non-absence failure instead of spending it as poll budget', async () => {
  vi.useFakeTimers();
  let calls = 0;
  // The message deliberately says "alert not found"; only the missing typed evidence matters.
  mockRunner.mockImplementation(async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', 'runner transport closed: alert not found');
  });

  const outcome = awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 5_000 },
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(6_000);

  assert.match(String(((await outcome) as Error).message), /runner transport closed/);
  assert.equal(calls, 1);
});

test('an action does not retry a failure that only reads like an absence', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', 'no alert service on this runner');
  });

  const outcome = actOnAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    'dismiss',
    undefined,
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.equal(calls, 1);
  // The fallback hint is absence-only advice, so an untyped failure must not carry it either.
  assert.equal(error.details?.hint, undefined);
});

test('a macOS action retries while more than a poll interval remains: its helper has no runner watchdog', async () => {
  vi.useFakeTimers();
  const firstReadMs = 2_000 - ALERT_POLL_INTERVAL_MS - ALERT_POLL_INTERVAL_MS - 1;
  mockHelper.mockImplementation(async () => {
    if (mockHelper.mock.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, firstReadMs));
      throw helperAbsence();
    }
    return { action: 'accept' };
  });

  const outcome = actOnAppleAlert(MACOS_DEVICE, runnerOptions, 'accept', undefined, process.env);
  await vi.advanceTimersByTimeAsync(firstReadMs + ALERT_POLL_INTERVAL_MS);

  assert.deepEqual(await outcome, { action: 'accept' });
  assert.equal(mockHelper.mock.calls.length, 2);
});

test('the macOS helper states absence as a typed reason, and the family retries it', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockHelper.mockImplementation(async () => {
    calls += 1;
    throw helperAbsence();
  });

  const outcome = actOnAppleAlert(
    MACOS_DEVICE,
    runnerOptions,
    'accept',
    undefined,
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.ok(calls > 1, 'a typed absence is retried');
  assert.match(String(error.details?.hint), /scoped snapshot/i);
});

// The macOS host answers through its helper, and a frontmost-app session names no bundle at all.
test('the macOS host reads through its helper, and a frontmost-app session names no bundle', async () => {
  mockHelper.mockResolvedValue({ title: 'Allow access' });

  await readAppleAlert(
    MACOS_DEVICE,
    runnerOptions,
    {
      surface: 'frontmost-app',
      appBundleId: 'com.example.app',
    },
    process.env,
  );

  assert.equal(mockRunner.mock.calls.length, 0);
  assert.deepEqual(mockHelper.mock.calls[0], [
    'get',
    { surface: 'frontmost-app', env: process.env },
  ]);
});

// The narrowing is the macOS helper's alone. A non-macOS Apple leaf keeps the session bundle
// whatever the surface says, exactly as the retired route passed it to the XCTest runner.
test('the XCTest runner keeps the session bundle even on a frontmost-app surface', async () => {
  mockRunner.mockResolvedValue({ title: 'Camera Access' });

  await readAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    {
      surface: 'frontmost-app',
      appBundleId: 'com.example.app',
    },
    process.env,
  );

  assert.deepEqual(mockRunner.mock.calls[0]?.[1], {
    command: 'alert',
    action: 'get',
    appBundleId: 'com.example.app',
    timeoutMs: 10_000,
  });
});

test('a macOS app session forwards the bundle its surface is scoped to', async () => {
  mockHelper.mockResolvedValue({ action: 'dismiss' });

  await actOnAppleAlert(
    MACOS_DEVICE,
    runnerOptions,
    'dismiss',
    {
      surface: 'app',
      appBundleId: 'com.example.app',
    },
    process.env,
  );

  assert.deepEqual(mockHelper.mock.calls[0], [
    'dismiss',
    { bundleId: 'com.example.app', surface: 'app', env: process.env },
  ]);
});

// An unreadable prompt is a prompt on screen. Retrying it is fine, since its host may become
// readable, but no window may end by reporting it as absence.
test('a read that meets an unreadable prompt is not an absent alert', async () => {
  mockRunner.mockRejectedValue(runnerUnresolved());

  await assert.rejects(
    alertIfPresent(readAppleAlert(IOS_SIMULATOR, runnerOptions, undefined, process.env)),
    (error: unknown) =>
      error instanceof AppError && error.details?.runnerErrorCode === ALERT_UNRESOLVED_RUNNER_CODE,
  );
});

test('a wait that ends on an unreadable prompt reports it, not an absence timeout', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    throw calls === 1 ? runnerAbsence() : runnerUnresolved();
  });

  const outcome = awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 900 },
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(2_000);
  const error = (await outcome) as AppError;

  assert.ok(calls > 1, 'an unreadable prompt is polled until the deadline');
  assert.equal(error.code, ALERT_UNRESOLVED_RUNNER_CODE);
  assert.equal(error.details?.dispatched, 'no');
});

test('a wait that polls past an unreadable prompt into a readable one answers it', async () => {
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw runnerUnresolved();
    return { title: 'Pair accessory' };
  });

  const result = await awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 5_000 },
    process.env,
  );

  assert.deepEqual(result, { title: 'Pair accessory' });
});

test.each(['accept', 'dismiss'] as const)(
  'an exhausted %s on an unreadable prompt keeps the runner hint, not the absence fallback',
  async (action) => {
    vi.useFakeTimers();
    let calls = 0;
    mockRunner.mockImplementation(async () => {
      calls += 1;
      throw runnerUnresolved();
    });

    const outcome = actOnAppleAlert(
      IOS_SIMULATOR,
      runnerOptions,
      action,
      undefined,
      process.env,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(3_500);
    const error = (await outcome) as AppError;

    assert.ok(calls > 1, 'an unreadable prompt is retried in the action window');
    assert.equal(error.code, ALERT_UNRESOLVED_RUNNER_CODE);
    assert.match(String(error.details?.hint), /screenshot/);
    assert.doesNotMatch(String(error.details?.hint), /scoped snapshot/i);
  },
);

test.each([
  ['unresolved', 4_630],
  ['absent', 4_630],
  ['unresolved', 4_400],
  ['absent', 4_400],
] as const)(
  'a wait retains a completed %s observation after a %d ms read',
  async (state, readMs) => {
    vi.useFakeTimers();
    const observed = state === 'unresolved' ? runnerUnresolved() : runnerAbsence();
    mockRunner.mockImplementation(async () => {
      if (mockRunner.mock.calls.length > 1) {
        throw new AppError('COMMAND_FAILED', 'runner timed out', {
          runnerErrorCode: 'MAIN_THREAD_TIMEOUT',
          dispatched: 'no',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, readMs));
      throw observed;
    });
    let settled = false;
    const outcome = awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 5_000 }, process.env)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    assert.equal(mockRunner.mock.calls.length, 1);
    assert.equal(settled, false);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await outcome) as AppError;
    assert.equal(mockRunner.mock.calls.length, 1);
    assert.equal(
      (mockRunner.mock.calls[0]?.[1] as { timeoutMs: number } | undefined)?.timeoutMs,
      5_000,
    );
    assert.equal((mockRunner.mock.calls[0]?.[1] as { action: string } | undefined)?.action, 'get');
    if (state === 'unresolved') {
      assert.equal(error, observed);
      assert.equal(error.details?.dispatched, 'no');
    } else {
      assert.equal(error.details?.reason, ALERT_WAIT_TIMEOUT_REASON);
      assert.equal(error.details?.runnerErrorCode, ALERT_NOT_FOUND_RUNNER_CODE);
    }
  },
);

test('a dispatched wait read propagates its main-thread watchdog after an unresolved observation', async () => {
  vi.useFakeTimers();
  const watchdog = new AppError('COMMAND_FAILED', 'runner main thread timed out', {
    runnerErrorCode: 'MAIN_THREAD_TIMEOUT',
    dispatched: 'no',
  });
  mockRunner.mockImplementation(async (_device, command) => {
    if (mockRunner.mock.calls.length === 1) throw runnerUnresolved();
    await new Promise((resolve) =>
      setTimeout(resolve, (command as { timeoutMs: number }).timeoutMs),
    );
    throw watchdog;
  });
  const outcome = awaitAppleAlert(
    IOS_SIMULATOR,
    runnerOptions,
    { timeoutMs: 5_000 },
    process.env,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(await outcome, watchdog);
  assert.equal(mockRunner.mock.calls.length, 2);
  assert.equal(
    (mockRunner.mock.calls[1]?.[1] as { timeoutMs: number } | undefined)?.timeoutMs,
    4_700,
  );
  assert.ok(
    mockRunner.mock.calls.every((call) => (call[1] as { action: string }).action === 'get'),
  );
  assert.equal(watchdog.details?.dispatched, 'no');
});

test('a wait admits another read when more than one poll interval remains', async () => {
  vi.useFakeTimers();
  mockRunner.mockImplementation(async () => {
    if (mockRunner.mock.calls.length === 1) {
      await new Promise((resolve) => setTimeout(resolve, 4_399));
      throw runnerUnresolved();
    }
    return { title: 'Ready' };
  });
  const outcome = awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 5_000 }, process.env);
  await vi.advanceTimersByTimeAsync(4_699);
  assert.deepEqual(await outcome, { title: 'Ready' });
  assert.equal(
    (mockRunner.mock.calls[1]?.[1] as { timeoutMs: number } | undefined)?.timeoutMs,
    301,
  );
});

test.each(['accept', 'dismiss'] as const)(
  'an %s retries an unresolved alert and acts when controls become readable',
  async (action) => {
    vi.useFakeTimers();
    mockRunner.mockRejectedValueOnce(runnerUnresolved()).mockResolvedValueOnce({ message: 'done' });
    const outcome = actOnAppleAlert(IOS_SIMULATOR, runnerOptions, action, undefined, process.env);
    await vi.advanceTimersByTimeAsync(300);
    assert.deepEqual(await outcome, { message: 'done' });
    assert.equal(mockRunner.mock.calls.length, 2);
    assert.ok(
      mockRunner.mock.calls.every((call) => (call[1] as { action: string }).action === action),
    );
  },
);
