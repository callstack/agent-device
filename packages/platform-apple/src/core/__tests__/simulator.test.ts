import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  ensureBootedSimulator,
  openIosSimulatorApp,
  wasSimulatorRecentlyObservedBooted,
} from '../simulator.ts';
import { IOS_BOOT_TIMEOUT_MS, IOS_SIMULATOR_FOCUS_TIMEOUT_MS } from '../config.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);

const mockRunCmd = vi.mocked(runCmd);

type MockRunCmdResult = Awaited<ReturnType<typeof runCmd>>;
type MockRunCmdResponse = MockRunCmdResult | (() => MockRunCmdResult);

const OK_RESULT: MockRunCmdResult = { exitCode: 0, stdout: '', stderr: '' };

function mockRunCmdResponses(responses: Record<string, MockRunCmdResponse>): void {
  mockRunCmd.mockImplementation(async (cmd, args) => {
    const key = formatMockRunCmdCall(cmd, args);
    const response = responses[key];
    if (!response) throw new Error(`Unexpected command: ${key}`);
    return typeof response === 'function' ? response() : response;
  });
}

function formatMockRunCmdCall(cmd: string, args: readonly string[]): string {
  return `${cmd} ${args.join(' ')}`;
}

function simulatorListDevicesResult(state: string): MockRunCmdResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'sim-1', state }],
      },
    }),
    stderr: '',
  };
}

function simulatorStateSequence(...states: string[]): () => MockRunCmdResult {
  let index = 0;
  return () => simulatorListDevicesResult(states[index++] ?? states.at(-1) ?? 'Booted');
}

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
});

test('ensureBootedSimulator opens Simulator after cold boot', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown', 'Booted'),
    'xcrun simctl boot sim-1': OK_RESULT,
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
    'open -a Simulator': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR);

  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-a Simulator',
    ),
    true,
  );
});

test('openIosSimulatorApp opens Simulator', async () => {
  mockRunCmdResponses({
    'open -a Simulator': OK_RESULT,
  });

  await openIosSimulatorApp();

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, args.join(' ')]),
    [['open', '-a Simulator']],
  );
});

test('ensureBootedSimulator leaves the Simulator app alone when already booted', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Booted'),
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR);

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, args.join(' ')]),
    [['xcrun', 'simctl list devices -j']],
  );
});

test('openIosSimulatorApp times out instead of hanging indefinitely', async () => {
  mockRunCmd.mockImplementation(async (cmd, args, options) => {
    assert.equal(cmd, 'open');
    assert.deepEqual(args, ['-a', 'Simulator']);
    assert.equal(options?.timeoutMs, IOS_SIMULATOR_FOCUS_TIMEOUT_MS);
    throw new AppError('COMMAND_FAILED', 'open timed out after 10000ms', {
      timeoutMs: options?.timeoutMs,
    });
  });

  await assert.rejects(
    () => openIosSimulatorApp(),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      assert.equal((error as AppError).code, 'COMMAND_FAILED');
      assert.match((error as AppError).message, /open timed out after 10000ms/);
      return true;
    },
  );
});

function failedSimctlBoot(stderr: string): MockRunCmdResult {
  return { exitCode: 1, stdout: '', stderr };
}

/**
 * Drives the retry delays and the boot deadline from the fake clock: every timer the boot path
 * schedules runs to completion, so a test that expects three attempts never sleeps for real. The
 * outcome is captured the moment it settles because the boot path can reject while the fake clock
 * is still turning, and an unobserved rejection would surface as an unhandled error.
 */
async function settleBoot(promise: Promise<void>): Promise<void> {
  const settled = promise.then(
    () => ({ ok: true as const, error: undefined }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
}

beforeEach(() => {
  // The boot memo is process-global, and a simulator remembered as Booted makes `ensureBooted`
  // skip `simctl list` and return before the retry policy is reached — which would turn every
  // case below into a pass that never booted anything. The unit lane clears process memos after
  // each case (SETUP_FILES in vitest.config.ts); this asserts it held for the memo that matters
  // here rather than trusting it across the whole lane.
  assert.equal(
    wasSimulatorRecentlyObservedBooted(IOS_TEST_SIMULATOR),
    false,
    'the process-global Booted memo survived a previous case',
  );
  vi.useFakeTimers({ now: 1_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

test('ensureBootedSimulator retries a transient simctl boot failure and boots on the next attempt', async () => {
  let bootCalls = 0;
  mockRunCmdResponses({
    // The initial read says Shutdown; the attempt that lands the boot re-reads it as Booted.
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown', 'Booted'),
    'xcrun simctl boot sim-1': () => {
      bootCalls += 1;
      return bootCalls === 1 ? failedSimctlBoot('Unable to boot sim-1 right now') : OK_RESULT;
    },
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
    'open -a Simulator': OK_RESULT,
  });

  await settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR));

  // A boot failure that names no timeout or resource pressure is worth another attempt, and the
  // second attempt is what proves the retry policy let it through rather than the harness.
  assert.equal(bootCalls, 2);
  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-a Simulator',
    ),
    true,
  );
});

test('ensureBootedSimulator gives up without retrying a boot that reports a timeout', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Shutdown'),
    'xcrun simctl boot sim-1': () => failedSimctlBoot('timed out waiting for the device to boot'),
  });

  await assert.rejects(
    () => settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR)),
    (error: unknown) => {
      assert.equal(error instanceof AppError, true);
      const bootError = error as AppError;
      assert.equal(bootError.message, 'iOS simulator failed to boot');
      assert.equal(bootError.details?.reason, 'IOS_BOOT_TIMEOUT');
      assert.match(String(bootError.details?.hint), /simctl bootstatus logs/);
      // The failure happened before any bootstatus ran, so the classifier had to fall back to
      // the boot output: the typed reason proves it read the capture that exists.
      assert.deepEqual(bootError.details?.boot, {
        exitCode: 1,
        stdout: '',
        stderr: 'timed out waiting for the device to boot',
      });
      assert.equal(bootError.details?.bootstatus, undefined);
      return true;
    },
  );

  assert.equal(
    mockRunCmd.mock.calls.filter(([, args]) => args.includes('boot') && args.includes('sim-1'))
      .length,
    1,
  );
});

test('ensureBootedSimulator gives up without retrying a boot killed by resource starvation', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Shutdown'),
    'xcrun simctl boot sim-1': () => failedSimctlBoot('Killed: 9'),
  });

  await assert.rejects(
    () => settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR)),
    (error: unknown) => {
      const bootError = error as AppError;
      assert.equal(bootError.details?.reason, 'CI_RESOURCE_STARVATION_SUSPECTED');
      assert.match(String(bootError.details?.hint), /resource constrained/);
      return true;
    },
  );

  assert.equal(
    mockRunCmd.mock.calls.filter(([, args]) => args[1] === 'boot' && args[2] === 'sim-1').length,
    1,
  );
});

test('ensureBootedSimulator stops retrying when only the bootstatus output reports a timeout', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Shutdown'),
    'xcrun simctl boot sim-1': OK_RESULT,
    // `bootstatus -b` exits happily but its own progress output says the wait timed out, and the
    // state re-read that follows is what fails. Its error carries no command output, so only the
    // captured bootstatus can turn this into a boot timeout.
    'xcrun simctl bootstatus sim-1 -b': {
      exitCode: 0,
      stdout: 'Waiting for the device to boot\nTimed out waiting for the device to boot\n',
      stderr: '',
    },
  });

  await assert.rejects(
    () => settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR)),
    (error: unknown) => {
      const bootError = error as AppError;
      assert.equal(bootError.details?.reason, 'IOS_BOOT_TIMEOUT');
      assert.deepEqual(bootError.details?.bootstatus, {
        exitCode: 0,
        stdout: 'Waiting for the device to boot\nTimed out waiting for the device to boot\n',
        stderr: '',
      });
      return true;
    },
  );

  assert.equal(mockRunCmd.mock.calls.filter(([, args]) => args[1] === 'boot').length, 1);
});

test('ensureBootedSimulator reports a simulator that never reaches Booted after every attempt', async () => {
  mockRunCmdResponses({
    // Every attempt re-reads the state and finds the simulator still starting.
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown'),
    'xcrun simctl boot sim-1': OK_RESULT,
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
  });

  await assert.rejects(
    () => settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR)),
    (error: unknown) => {
      const bootError = error as AppError;
      assert.equal(bootError.details?.reason, 'BOOT_COMMAND_FAILED');
      assert.equal(bootError.details?.deviceId, 'sim-1');
      assert.equal(bootError.details?.timeoutMs, IOS_BOOT_TIMEOUT_MS);
      return true;
    },
  );

  assert.equal(mockRunCmd.mock.calls.filter(([, args]) => args[1] === 'boot').length, 3);
  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-a Simulator',
    ),
    false,
  );
});

test('ensureBootedSimulator stops at the boot deadline instead of starting another attempt', async () => {
  let booted = false;
  mockRunCmd.mockImplementation(async (cmd, args) => {
    const key = formatMockRunCmdCall(cmd, args);
    if (key === 'xcrun simctl list devices -j') {
      // Once the attempt that fails has re-read the state, the boot budget is spent: the policy
      // must clamp its wait to zero and stop, not spawn another `simctl boot`.
      const listReads = mockRunCmd.mock.calls.filter(([, callArgs]) =>
        callArgs.includes('list'),
      ).length;
      if (listReads === 2) vi.advanceTimersByTime(IOS_BOOT_TIMEOUT_MS);
      return simulatorListDevicesResult('Shutdown');
    }
    if (key === 'xcrun simctl boot sim-1') {
      assert.ok(!booted, 'the deadline must stop the second attempt before it runs simctl boot');
      booted = true;
      return OK_RESULT;
    }
    if (key === 'xcrun simctl bootstatus sim-1 -b') return OK_RESULT;
    throw new Error(`Unexpected command: ${key}`);
  });

  await assert.rejects(
    () => settleBoot(ensureBootedSimulator(IOS_TEST_SIMULATOR)),
    (error: unknown) => {
      const bootError = error as AppError;
      assert.equal(bootError.message, 'iOS simulator failed to boot');
      assert.equal(
        (bootError.details?.elapsedMs as number) >= IOS_BOOT_TIMEOUT_MS,
        true,
        `expected the budget to be spent, saw ${String(bootError.details?.elapsedMs)}ms`,
      );
      return true;
    },
  );

  assert.equal(booted, true);
});
