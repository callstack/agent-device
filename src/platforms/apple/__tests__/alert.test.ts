import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

vi.mock('../core/runner-client.ts', () => ({ runAppleRunnerCommand: vi.fn() }));
vi.mock('../os/macos/helper.ts', () => ({ runMacOsAlertAction: vi.fn() }));

import {
  ALERT_NOT_FOUND_REASON,
  ALERT_NOT_FOUND_RUNNER_CODE,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR, MACOS_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { runMacOsAlertAction } from '../os/macos/helper.ts';
import { actOnAppleAlert, awaitAppleAlert, readAppleAlert } from '../alert.ts';

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
test('a read spends the family default, not the caller window', async () => {
  mockRunner.mockResolvedValue({ title: 'Camera Access' });

  await readAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 37 });

  assert.equal(mockRunner.mock.calls.length, 1);
  assert.deepEqual(mockRunner.mock.calls[0]?.[1], {
    command: 'alert',
    action: 'get',
    appBundleId: undefined,
    timeoutMs: 10_000,
  });
});

test('a wait polls until one attempt answers, and the first attempt gets the whole window', async () => {
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw runnerAbsence();
    return { title: 'Camera Access' };
  });

  const result = await awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 5_000 });

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

  const outcome = awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 900 }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(2_000);

  assert.match(String(((await outcome) as Error).message), /alert wait timed out/);
});

test('an accept retries only while the backend says the alert is not there yet', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockRunner.mockImplementation(async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', 'runner crashed');
  });

  const outcome = actOnAppleAlert(IOS_SIMULATOR, runnerOptions, 'accept').then(
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

  const outcome = actOnAppleAlert(IOS_SIMULATOR, runnerOptions, 'accept').then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.equal(error.message, 'alert not found');
  assert.match(String(error.details?.hint), /scoped snapshot/i);
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

  const outcome = awaitAppleAlert(IOS_SIMULATOR, runnerOptions, { timeoutMs: 5_000 }).then(
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

  const outcome = actOnAppleAlert(IOS_SIMULATOR, runnerOptions, 'dismiss').then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.equal(calls, 1);
  // The fallback hint is absence-only advice, so an untyped failure must not carry it either.
  assert.equal(error.details?.hint, undefined);
});

test('the macOS helper states absence as a typed reason, and the family retries it', async () => {
  vi.useFakeTimers();
  let calls = 0;
  mockHelper.mockImplementation(async () => {
    calls += 1;
    throw helperAbsence();
  });

  const outcome = actOnAppleAlert(MACOS_DEVICE, runnerOptions, 'accept').then(
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

  await readAppleAlert(MACOS_DEVICE, runnerOptions, {
    surface: 'frontmost-app',
    appBundleId: 'com.example.app',
  });

  assert.equal(mockRunner.mock.calls.length, 0);
  assert.deepEqual(mockHelper.mock.calls[0], ['get', { surface: 'frontmost-app' }]);
});

// The narrowing is the macOS helper's alone. A non-macOS Apple leaf keeps the session bundle
// whatever the surface says, exactly as the retired route passed it to the XCTest runner.
test('the XCTest runner keeps the session bundle even on a frontmost-app surface', async () => {
  mockRunner.mockResolvedValue({ title: 'Camera Access' });

  await readAppleAlert(IOS_SIMULATOR, runnerOptions, {
    surface: 'frontmost-app',
    appBundleId: 'com.example.app',
  });

  assert.deepEqual(mockRunner.mock.calls[0]?.[1], {
    command: 'alert',
    action: 'get',
    appBundleId: 'com.example.app',
    timeoutMs: 10_000,
  });
});

test('a macOS app session forwards the bundle its surface is scoped to', async () => {
  mockHelper.mockResolvedValue({ action: 'dismiss' });

  await actOnAppleAlert(MACOS_DEVICE, runnerOptions, 'dismiss', {
    surface: 'app',
    appBundleId: 'com.example.app',
  });

  assert.deepEqual(mockHelper.mock.calls[0], [
    'dismiss',
    { bundleId: 'com.example.app', surface: 'app' },
  ]);
});
