import { bindTestCommandHost } from '@agent-device/test-kit';
import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
import { withMockedMacOsHelper } from './macos-helper-test-utils.ts';
import { IOS_TEST_SIMULATOR, MACOS_TEST_DEVICE } from './apple-core-stub-helpers.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);
const mockEnsureBootedSimulator = vi.mocked(ensureBootedSimulator);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunCmd.mockImplementation(execActual.runCmd);
  mockEnsureBootedSimulator.mockImplementation(simulatorActual.ensureBootedSimulator);
});

test('closeIosApp on macOS uses helper quit for bundle identifiers', async () => {
  await withMockedMacOsHelper(
    [
      '#!/bin/sh',
      String.raw`printf "%s\n" "$@" > "$AGENT_DEVICE_TEST_ARGS_FILE"`,
      "cat <<'JSON'",
      '{"ok":true,"data":{"bundleId":"com.example.foobar","running":false,"terminated":false,"forceTerminated":false}}',
      'JSON',
      '',
    ].join('\n'),
    async ({ tmpDir }) => {
      const argsLogPath = path.join(tmpDir, 'args.log');
      const previousArgsFile = process.env.AGENT_DEVICE_TEST_ARGS_FILE;
      process.env.AGENT_DEVICE_TEST_ARGS_FILE = argsLogPath;

      try {
        await closeIosApp(MACOS_TEST_DEVICE, 'com.example.foobar', undefined, process.env);
        const logged = await fs.readFile(argsLogPath, 'utf8');
        assert.equal(logged, 'app\nquit\n--bundle-id\ncom.example.foobar\n');
      } finally {
        if (previousArgsFile === undefined) delete process.env.AGENT_DEVICE_TEST_ARGS_FILE;
        else process.env.AGENT_DEVICE_TEST_ARGS_FILE = previousArgsFile;
      }
    },
    { tempPrefix: 'agent-device-macos-close-helper-test-' },
  );
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
