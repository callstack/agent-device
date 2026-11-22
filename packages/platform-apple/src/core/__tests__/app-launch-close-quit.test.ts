import { bindTestCommandHost } from '@agent-device/test-kit';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

const execActual = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const simulatorActual = await vi.importActual<typeof import('../simulator.ts')>('../simulator.ts');

import { closeIosApp } from '../app-launch.ts';
import { ensureBootedSimulator } from '../simulator.ts';
import { IOS_SIMULATOR_TERMINATE_TIMEOUT_MS } from '../config.ts';
import { runCmd } from '@agent-device/host-kit/command';
import { bindMacOsLeafFixture } from '../../__tests__/macos-leaf.fixtures.ts';
import { IOS_TEST_SIMULATOR, MACOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
});

test('closeIosApp on macOS delegates the close to the installed leaf', async () => {
  const leaf = bindMacOsLeafFixture({ closeApp: async () => {} });

  await closeIosApp(MACOS_TEST_DEVICE, 'com.example.foobar', undefined, process.env);

  assert.deepEqual(leaf.calls, [
    { operation: 'closeApp', args: [MACOS_TEST_DEVICE, 'com.example.foobar', process.env] },
  ]);
  assert.equal(mockRunCmd.mock.calls.length, 0);
});

test('closeIosApp on iOS simulator bounds simctl terminate', async () => {
  mockEnsureBootedSimulator.mockResolvedValue(undefined);
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

  await closeIosApp(IOS_TEST_SIMULATOR, 'com.example.foobar', undefined, process.env);

  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]?.[0], 'xcrun');
  assert.deepEqual(mockRunCmd.mock.calls[0]?.[1], [
    'simctl',
    'terminate',
    'sim-1',
    'com.example.foobar',
  ]);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.allowFailure, true);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, IOS_SIMULATOR_TERMINATE_TIMEOUT_MS);
});
