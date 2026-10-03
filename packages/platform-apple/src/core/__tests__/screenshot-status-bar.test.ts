import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  invalidateSimulatorStatusBarOverrideCache,
  prepareSimulatorStatusBarForScreenshot,
} from '../screenshot-status-bar.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
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
