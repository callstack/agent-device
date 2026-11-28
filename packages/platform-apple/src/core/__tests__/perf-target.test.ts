import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(actual.runCmd),
  };
});

import { runCmd } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { parseApplePsOutput, resolveIosDevicePerfTarget } from '../perf-target.ts';

const mockRunCmd = vi.mocked(runCmd);

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone',
  kind: 'device',
  booted: true,
};

beforeEach(() => {
  mockRunCmd.mockReset();
});

test('parseApplePsOutput reads pid cpu rss and command columns', () => {
  const rows = parseApplePsOutput(
    ['123 12.5 45678 /Applications/Test.app/Contents/MacOS/Test --flag', '456 0.0 2048 Test'].join(
      '\n',
    ),
  );

  assert.deepEqual(rows, [
    {
      pid: 123,
      cpuPercent: 12.5,
      rssKb: 45678,
      command: '/Applications/Test.app/Contents/MacOS/Test --flag',
    },
    {
      pid: 456,
      cpuPercent: 0,
      rssKb: 2048,
      command: 'Test',
    },
  ]);
});

test('resolveIosDevicePerfTarget excludes app extensions while keeping main app executables', async () => {
  mockDevicectl(
    [
      {
        bundleIdentifier: 'com.example.app-dev',
        name: 'App',
        url: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/',
      },
    ],
    [
      {
        executable: 'file:///private/var/containers/Bundle/Application/PROD-1/App.app/App',
        processIdentifier: 10089,
      },
      {
        executable:
          'file:///private/var/containers/Bundle/Application/DEV-1/App.app/PlugIns/LiveActivityExtension.appex/LiveActivityExtension',
        processIdentifier: 10844,
      },
      {
        executable:
          'file:///private/var/containers/Bundle/Application/DEV-1/App.app/Extensions/Widget.appex/Widget',
        processIdentifier: 10845,
      },
      {
        executable: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/App',
        processIdentifier: 10870,
      },
    ],
  );

  const processes = await resolveIosDevicePerfTarget(IOS_DEVICE, 'com.example.app-dev');
  assert.deepEqual(processes, [
    {
      pid: 10870,
      executable: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/App',
    },
  ]);
});

test('resolveIosDevicePerfTarget fails when only extension processes are running', async () => {
  mockDevicectl(
    [
      {
        bundleIdentifier: 'com.example.app-dev',
        name: 'App',
        url: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/',
      },
    ],
    [
      {
        executable:
          'file:///private/var/containers/Bundle/Application/DEV-1/App.app/PlugIns/LiveActivityExtension.appex/LiveActivityExtension',
        processIdentifier: 10844,
      },
    ],
  );

  await assert.rejects(
    () => resolveIosDevicePerfTarget(IOS_DEVICE, 'com.example.app-dev'),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      /No running process found for com\.example\.app-dev/.test(error.message),
  );
});

function mockDevicectl(
  apps: Array<{ bundleIdentifier: string; name: string; url: string }>,
  runningProcesses: Array<{ executable: string; processIdentifier: number }>,
): void {
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd !== 'xcrun' || args[0] !== 'devicectl' || args[1] !== 'device' || args[2] !== 'info') {
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }
    const jsonOutPath = args[args.indexOf('--json-output') + 1]!;
    if (args[3] === 'apps') {
      await fs.writeFile(jsonOutPath, JSON.stringify({ result: { apps } }), 'utf8');
    } else if (args[3] === 'processes') {
      await fs.writeFile(jsonOutPath, JSON.stringify({ result: { runningProcesses } }), 'utf8');
    } else {
      throw new Error(`unexpected devicectl subject: ${args.join(' ')}`);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
}
