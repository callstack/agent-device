import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { ensureBootedSimulator, openIosSimulatorApp } from '../simulator.ts';
import { IOS_SIMULATOR_FOCUS_TIMEOUT_MS } from '../config.ts';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '../../../../utils/exec.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

vi.mock('../../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

const execActual = await vi.importActual<typeof import('../../../../utils/exec.ts')>(
  '../../../../utils/exec.ts',
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

function formatMockRunCmdCall(cmd: string, args: string[]): string {
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

test('ensureBootedSimulator opens Simulator after cold boot by default', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown', 'Booted'),
    'xcrun simctl boot sim-1': OK_RESULT,
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
    'open -a Simulator': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, { focusExisting: true });

  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-a Simulator',
    ),
    true,
  );
});

test('ensureBootedSimulator runs cold boot callback only before cold boot', async () => {
  const onColdBootStart = vi.fn();
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown', 'Booted'),
    'xcrun simctl boot sim-1': OK_RESULT,
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
    'open -a Simulator': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, {
    focusExisting: true,
    onColdBootStart,
  });

  assert.equal(onColdBootStart.mock.calls.length, 1);
  assert.deepEqual(onColdBootStart.mock.calls[0], [IOS_TEST_SIMULATOR]);
});

test('openIosSimulatorApp opens Simulator by default', async () => {
  mockRunCmdResponses({
    'open -a Simulator': OK_RESULT,
  });

  await openIosSimulatorApp();

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, args.join(' ')]),
    [['open', '-a Simulator']],
  );
});

test('openIosSimulatorApp uses Device Hub when opted in and falls back to Simulator', async () => {
  mockRunCmdResponses({
    'open -a Device Hub': {
      exitCode: 1,
      stdout: '',
      stderr: 'Unable to find application named Device Hub',
    },
    'open -a Simulator': OK_RESULT,
  });

  await openIosSimulatorApp({ deviceHub: true });

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, args.join(' ')]),
    [
      ['open', '-a Device Hub'],
      ['open', '-a Simulator'],
    ],
  );
});

test('ensureBootedSimulator opens Simulator when already booted by default', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Booted'),
    'open -a Simulator': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, { focusExisting: true });

  assert.deepEqual(
    mockRunCmd.mock.calls.map(([cmd, args]) => [cmd, args.join(' ')]),
    [
      ['xcrun', 'simctl list devices -j'],
      ['open', '-a Simulator'],
    ],
  );
});

test('ensureBootedSimulator skips cold boot callback when already booted', async () => {
  const onColdBootStart = vi.fn();
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Booted'),
    'open -a Simulator': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, { focusExisting: true, onColdBootStart });

  assert.equal(onColdBootStart.mock.calls.length, 0);
});

test('ensureBootedSimulator opens Device Hub without activation when already booted and opted in', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorListDevicesResult('Booted'),
    'open -g -a Device Hub': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, { deviceHub: true, focusExisting: true });

  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-g -a Device Hub',
    ),
    true,
  );
  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-g -a Simulator',
    ),
    false,
  );
});

test('ensureBootedSimulator foregrounds Device Hub after cold boot when opted in', async () => {
  mockRunCmdResponses({
    'xcrun simctl list devices -j': simulatorStateSequence('Shutdown', 'Booted'),
    'xcrun simctl boot sim-1': OK_RESULT,
    'xcrun simctl bootstatus sim-1 -b': OK_RESULT,
    'open -a Device Hub': OK_RESULT,
  });

  await ensureBootedSimulator(IOS_TEST_SIMULATOR, { deviceHub: true, focusExisting: true });

  assert.equal(
    mockRunCmd.mock.calls.some(
      ([cmd, args]) => cmd === 'open' && args.join(' ') === '-a Device Hub',
    ),
    true,
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
