import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmd: vi.fn(actual.runCmd),
    runCmdBackground: vi.fn(actual.runCmdBackground),
  };
});

import { runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  startAppleXctracePerfCapture,
  stopAppleXctracePerfCapture,
  type AppleXctracePerfCapture,
} from '../perf-xctrace.ts';
import {
  mockBackgroundXctrace,
  mockIosDeviceBundleHandlers,
  mockXcrunCommands,
} from './perf.fixtures.ts';

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  id: 'ios-device-1',
  name: 'iPhone Device',
  kind: 'device',
  booted: true,
};

beforeEach(() => {
  vi.mocked(runCmd).mockReset();
  vi.mocked(runCmdBackground).mockReset();
});

// Both xctrace exit waits now go through host-kit's settleWithin. The hand-rolled race they
// replaced left its timer armed for the whole budget after xctrace had already exited.
test('stopAppleXctracePerfCapture clears the grace deadline once xctrace exits', async () => {
  const tmpDir = await mkdtempForTest('agent-device-xctrace-stop-timer-');
  const tracePath = path.join(tmpDir, 'app.trace');
  await fs.writeFile(tracePath, 'trace', 'utf8');
  const child = { kill: vi.fn((_signal?: NodeJS.Signals) => true), pid: 1234 };
  const capture: AppleXctracePerfCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: tracePath,
    appBundleId: 'com.example.app',
    deviceId: 'sim-1',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: child as unknown as AppleXctracePerfCapture['child'],
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };

  try {
    vi.useFakeTimers();
    try {
      await stopAppleXctracePerfCapture(capture);
      assert.equal(
        vi.getTimerCount(),
        0,
        'the exit wait cleared its deadline once the process reported its exit',
      );
    } finally {
      vi.useRealTimers();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('startAppleXctracePerfCapture excludes iOS .appex extension pids on device', async () => {
  const tmpDir = await mkdtempForTest('agent-device-xctrace-exclude-appex-');
  const tracePath = path.join(tmpDir, 'app.trace');
  mockXcrunCommands(
    mockIosDeviceBundleHandlers(
      [
        {
          bundleIdentifier: 'com.example.app-dev',
          name: 'App Dev',
          url: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/',
        },
      ],
      [
        {
          executable:
            'file:///private/var/containers/Bundle/Application/DEV-1/App.app/PlugIns/LiveActivityExtension.appex/LiveActivityExtension',
          processIdentifier: 10844,
        },
        {
          executable: 'file:///private/var/containers/Bundle/Application/DEV-1/App.app/App',
          processIdentifier: 10870,
        },
      ],
    ),
  );
  vi.mocked(runCmdBackground).mockImplementationOnce(() => mockBackgroundXctrace());

  try {
    const capture = await startAppleXctracePerfCapture({
      device: IOS_DEVICE,
      appBundleId: 'com.example.app-dev',
      mode: 'cpu-profile',
      template: 'Time Profiler',
      outPath: tracePath,
    });
    assert.deepEqual(capture.targetPids, [10870]);
    assert.deepEqual(capture.targetProcesses, ['App']);
    assert.deepEqual(vi.mocked(runCmdBackground).mock.calls[0]?.[1], [
      'xctrace',
      'record',
      '--template',
      'Time Profiler',
      '--device',
      'ios-device-1',
      '--attach',
      '10870',
      '--output',
      tracePath,
      '--quiet',
      '--no-prompt',
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
