import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

vi.mock('../core/runner/runner-client.ts', () => ({ runAppleRunnerCommand: vi.fn() }));
vi.mock('../os/macos/helper.ts', () => ({ runMacOsAlertAction: vi.fn() }));

import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR, MACOS_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import { runAppleRunnerCommand } from '../core/runner/runner-client.ts';
import { runMacOsAlertAction } from '../os/macos/helper.ts';
import { actOnAppleAlert, awaitAppleAlert, readAppleAlert } from '../alert.ts';

const mockRunner = vi.mocked(runAppleRunnerCommand);
const mockHelper = vi.mocked(runMacOsAlertAction);
const runnerOptions = {};

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
    if (calls === 1) throw new AppError('COMMAND_FAILED', 'alert not found');
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
  mockRunner.mockRejectedValue(new AppError('COMMAND_FAILED', 'alert not found'));

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
  mockRunner.mockRejectedValue(new AppError('COMMAND_FAILED', 'alert not found'));

  const outcome = actOnAppleAlert(IOS_SIMULATOR, runnerOptions, 'accept').then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(3_500);
  const error = (await outcome) as AppError;

  assert.equal(error.message, 'alert not found');
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
