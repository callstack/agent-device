import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import {
  invalidateSimulatorStatusBarOverrideCache,
  prepareSimulatorStatusBarForScreenshot,
} from '../screenshot-status-bar.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

// The fake tool provider installs through the production withAppleToolProvider
// scope, so `calls` records the flat invocations the PATH-stub scripts saw.

const STATUS_BAR_OVERRIDES_LISTING = `Current Status Bar Overrides:
=============================
Time: 6:07
DataNetworkType: 0
WiFi Mode: 2, WiFi Bars: 0
Cell Mode: 2, Cell Bars: 0
Operator Name: No Service
Battery State: 1, Battery Level: 42, Not Charging: 0`;

function statusBarScript(listResponse: () => string | { stderr: string; exitCode: number }) {
  return (args: string[]) => {
    if (args[0] !== 'simctl' || args[1] !== 'status_bar') {
      return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
    }
    if (args[3] === 'list') return listResponse();
    if (args[3] === 'clear' || args[3] === 'override') return '';
    return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
  };
}

// A status bar step that fails best-effort has to reach the request log, or a debug run cannot
// explain why a screenshot still shows a non-deterministic status bar.
async function statusBarDiagnosticEvents(run: () => Promise<unknown>) {
  const logPath = path.join(
    await mkdtempForTest('agent-device-ios-status-bar-diag-'),
    'log.ndjson',
  );
  await withDiagnosticsScope({ command: 'screenshot', debug: true, logPath }, run);
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { level: string; phase: string; data?: Record<string, unknown> },
    )
    .filter((event) => event.phase.startsWith('ios_screenshot_status_bar_'))
    .map(({ level, phase, data }) => ({ level, phase, data }));
}

beforeEach(() => {
  invalidateSimulatorStatusBarOverrideCache(IOS_TEST_SIMULATOR);
});

test('prepareSimulatorStatusBarForScreenshot restores prior visible overrides', async () => {
  await withFakeAppleTool(
    statusBarScript(() => STATUS_BAR_OVERRIDES_LISTING),
    async ({ calls }) => {
      const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restore();

      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          'simctl status_bar sim-1 clear',
          'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
          'simctl status_bar sim-1 clear',
          'simctl status_bar sim-1 override --dataNetwork hide --wifiMode failed --wifiBars 0 --cellularMode failed --cellularBars 0 --operatorName No Service',
        ],
      );
    },
  );
});

test('prepareSimulatorStatusBarForScreenshot skips known redundant status bar commands', async () => {
  await withFakeAppleTool(
    statusBarScript(() => 'Current Status Bar Overrides:\n============================='),
    async ({ calls }) => {
      const restoreFirst = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restoreFirst();
      const restoreSecond = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restoreSecond();

      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
          'simctl status_bar sim-1 clear',
          'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
          'simctl status_bar sim-1 clear',
        ],
      );
    },
  );
});

test('prepareSimulatorStatusBarForScreenshot still normalizes when snapshotting current overrides fails', async () => {
  await withFakeAppleTool(
    statusBarScript(() => ({ stderr: 'list failed', exitCode: 1 })),
    async ({ calls }) => {
      const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restore();

      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          'simctl status_bar sim-1 clear',
          'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
          'simctl status_bar sim-1 clear',
        ],
      );
    },
  );
});

// The command list above proves a failed step is tolerated; the log line is what proves the same
// run can be explained. One event per failed step, carrying the device it failed on and the
// normalized xcrun failure.
test('a failed status bar snapshot logs snapshot_failed with the tool failure', async () => {
  const events = await statusBarDiagnosticEvents(async () => {
    await withFakeAppleTool(
      statusBarScript(() => ({ stderr: 'list failed', exitCode: 1 })),
      async () => {
        const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
        await restore();
      },
    );
  });

  assert.deepEqual(events, [
    {
      level: 'warn',
      phase: 'ios_screenshot_status_bar_snapshot_failed',
      data: {
        platform: 'apple',
        deviceKind: 'simulator',
        deviceId: 'sim-1',
        errorCode: 'COMMAND_FAILED',
        reason: 'Failed to read simulator status bar overrides',
        exitCode: 1,
        stderr: 'list failed',
      },
    },
  ]);
});

test('a failed status bar override logs prepare_failed and the step stays best-effort', async () => {
  const events = await statusBarDiagnosticEvents(async () => {
    await withFakeAppleTool(
      (args) => {
        if (args[3] === 'list')
          return 'Current Status Bar Overrides:\n=============================';
        if (args[3] === 'override') {
          return new AppError('COMMAND_FAILED', 'override rejected', {
            exitCode: 7,
            stderr: 'override rejected',
          });
        }
        return '';
      },
      async ({ calls }) => {
        const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
        await restore();
        // The deterministic override is the step that fails, so the screenshot proceeds with
        // whatever status bar the simulator kept, and restoration still runs.
        assert.deepEqual(
          calls.map((args) => args.join(' ')),
          [
            'simctl status_bar sim-1 list',
            'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
            'simctl status_bar sim-1 clear',
          ],
        );
      },
    );
  });

  assert.deepEqual(events, [
    {
      level: 'warn',
      phase: 'ios_screenshot_status_bar_prepare_failed',
      data: {
        platform: 'apple',
        deviceKind: 'simulator',
        deviceId: 'sim-1',
        errorCode: 'COMMAND_FAILED',
        reason: 'override rejected',
        exitCode: 7,
        stderr: 'override rejected',
      },
    },
  ]);
});
