import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { ensureBootedSimulator, openIosSimulatorApp } from '../simulator.ts';
import { IOS_SIMULATOR_FOCUS_TIMEOUT_MS } from '../config.ts';
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
