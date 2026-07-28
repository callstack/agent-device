import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import {
  invalidateSimulatorStatusBarOverrideCache,
  prepareSimulatorStatusBarForScreenshot,
} from '../screenshot-status-bar.ts';
import { IOS_TEST_SIMULATOR, withMockedXcrun } from './apple-core-stub-helpers.ts';

beforeEach(() => {
  invalidateSimulatorStatusBarOverrideCache(IOS_TEST_SIMULATOR);
});

test('prepareSimulatorStatusBarForScreenshot restores prior visible overrides', async () => {
  await withMockedXcrun(
    'agent-device-ios-status-bar-restore-test-',
    `#!/bin/sh
echo "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "list" ]; then
  cat <<'OUT'
Current Status Bar Overrides:
=============================
Time: 6:07
DataNetworkType: 0
WiFi Mode: 2, WiFi Bars: 0
Cell Mode: 2, Cell Bars: 0
Operator Name: No Service
Battery State: 1, Battery Level: 42, Not Charging: 0
OUT
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "clear" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "override" ]; then
  exit 0
fi
echo "unexpected xcrun args: $*" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restore();

      const logLines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(logLines, [
        'simctl status_bar sim-1 list',
        'simctl status_bar sim-1 clear',
        'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
        'simctl status_bar sim-1 clear',
        'simctl status_bar sim-1 override --dataNetwork hide --wifiMode failed --wifiBars 0 --cellularMode failed --cellularBars 0 --operatorName No Service',
      ]);
    },
  );
});

test('prepareSimulatorStatusBarForScreenshot skips known redundant status bar commands', async () => {
  await withMockedXcrun(
    'agent-device-ios-status-bar-no-overrides-test-',
    `#!/bin/sh
echo "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "list" ]; then
  cat <<'OUT'
Current Status Bar Overrides:
=============================
OUT
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "clear" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "override" ]; then
  exit 0
fi
echo "unexpected xcrun args: $*" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const restoreFirst = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restoreFirst();
      const restoreSecond = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restoreSecond();

      const logLines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(logLines, [
        'simctl status_bar sim-1 list',
        'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
        'simctl status_bar sim-1 clear',
        'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
        'simctl status_bar sim-1 clear',
      ]);
    },
  );
});

test('prepareSimulatorStatusBarForScreenshot still normalizes when snapshotting current overrides fails', async () => {
  await withMockedXcrun(
    'agent-device-ios-status-bar-snapshot-failure-test-',
    `#!/bin/sh
echo "$*" >> "$AGENT_DEVICE_TEST_ARGS_FILE"
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "list" ]; then
  echo "list failed" >&2
  exit 1
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "clear" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "status_bar" ] && [ "$4" = "override" ]; then
  exit 0
fi
echo "unexpected xcrun args: $*" >&2
exit 1
`,
    async ({ argsLogPath }) => {
      const restore = await prepareSimulatorStatusBarForScreenshot(IOS_TEST_SIMULATOR);
      await restore();

      const logLines = (await fs.readFile(argsLogPath, 'utf8')).trim().split('\n').filter(Boolean);
      assert.deepEqual(logLines, [
        'simctl status_bar sim-1 list',
        'simctl status_bar sim-1 clear',
        'simctl status_bar sim-1 override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100',
        'simctl status_bar sim-1 clear',
      ]);
    },
  );
});
