import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';
import { IOS_SIMULATOR_TERMINATE_TIMEOUT_MS } from '../config.ts';

vi.mock('../../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});

import { runCmd } from '../../../../utils/exec.ts';
import { ensureBootedSimulator } from '../simulator.ts';
import { openIosApp } from '../app-launch.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockEnsureBootedSimulator.mockResolvedValue();
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('iOS simulator URL relaunch terminates the app before opening the URL', async () => {
  await openIosApp(IOS_TEST_SIMULATOR, 'MyApp', {
    appBundleId: 'com.example.app',
    url: 'myapp://automation',
    terminateRunningApp: true,
  });

  assert.deepEqual(mockRunCmd.mock.calls, [
    [
      'xcrun',
      ['simctl', 'terminate', 'sim-1', 'com.example.app'],
      {
        allowFailure: true,
        timeoutMs: IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
      },
    ],
    ['xcrun', ['simctl', 'openurl', 'sim-1', 'myapp://automation'], undefined],
  ]);
});

test('iOS simulator deep-link relaunch terminates the active app before opening the URL', async () => {
  await openIosApp(IOS_TEST_SIMULATOR, 'myapp://automation', {
    appBundleId: 'com.example.app',
    terminateRunningApp: true,
  });

  assert.deepEqual(mockRunCmd.mock.calls, [
    [
      'xcrun',
      ['simctl', 'terminate', 'sim-1', 'com.example.app'],
      {
        allowFailure: true,
        timeoutMs: IOS_SIMULATOR_TERMINATE_TIMEOUT_MS,
      },
    ],
    ['xcrun', ['simctl', 'openurl', 'sim-1', 'myapp://automation'], undefined],
  ]);
});
