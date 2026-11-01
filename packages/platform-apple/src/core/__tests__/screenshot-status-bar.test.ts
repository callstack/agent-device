import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import {
  invalidateSimulatorStatusBarOverrideCache,
  withNormalizedSimulatorStatusBar,
  withSimulatorStatusBarHeld,
} from '../screenshot-status-bar.ts';
import { withFakeAppleTool, type FakeAppleToolResponse } from '../../__tests__/fake-apple-tool.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';
import { statusBarDiagnosticEvents } from './screenshot-diagnostic-log.ts';

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

const NORMALIZE_ARGS =
  '--time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100';

const RESTORE_ARGS =
  '--dataNetwork hide --wifiMode failed --wifiBars 0 --cellularMode failed --cellularBars 0 --operatorName No Service';

function statusBarScript(listResponse: () => string | { stderr: string; exitCode: number }) {
  return (args: string[]): FakeAppleToolResponse | undefined => {
    if (args[0] !== 'simctl' || args[1] !== 'status_bar') {
      return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
    }
    if (args[3] === 'list') return listResponse();
    if (args[3] === 'clear' || args[3] === 'override') return '';
    return { stderr: `unexpected xcrun args: ${args.join(' ')}`, exitCode: 1 };
  };
}

/** The caller's step that the status bar surrounds; the status bar tests do not exercise it. */
async function capture(): Promise<string> {
  return 'captured';
}

beforeEach(() => {
  invalidateSimulatorStatusBarOverrideCache(IOS_TEST_SIMULATOR);
});

test('withNormalizedSimulatorStatusBar restores prior visible overrides', async () => {
  await withFakeAppleTool(
    statusBarScript(() => STATUS_BAR_OVERRIDES_LISTING),
    async ({ calls }) => {
      const captured = await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);

      assert.equal(captured, 'captured');
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          'simctl status_bar sim-1 clear',
          `simctl status_bar sim-1 override ${NORMALIZE_ARGS}`,
          'simctl status_bar sim-1 clear',
          `simctl status_bar sim-1 override ${RESTORE_ARGS}`,
        ],
      );
    },
  );
});

test('a capture leg nested in its own status bar window keeps it after the request aborts', async () => {
  // The sequence this pins: a normalized capture whose simctl leg fails falls back to the runner
  // leg while the window is still held. The request may abort in between; the leg the caller is
  // already inside must still run, and must not queue behind, or be rejected by, the window that
  // caller holds.
  const abortController = new AbortController();
  await withFakeAppleTool(
    statusBarScript(() => 'Current Status Bar Overrides:\n============================='),
    async ({ calls }) => {
      const captured = await withNormalizedSimulatorStatusBar(
        IOS_TEST_SIMULATOR,
        async () => {
          abortController.abort(new Error('caller gave up'));
          return await withSimulatorStatusBarHeld(
            IOS_TEST_SIMULATOR,
            capture,
            abortController.signal,
          );
        },
        abortController.signal,
      );

      assert.equal(captured, 'captured', 'the leg inside the window must run');
      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          `simctl status_bar sim-1 override ${NORMALIZE_ARGS}`,
          'simctl status_bar sim-1 clear',
        ],
        'the window must still restore once the aborted leg finishes',
      );
    },
  );
});

test('withNormalizedSimulatorStatusBar still normalizes when snapshotting current overrides fails', async () => {
  await withFakeAppleTool(
    statusBarScript(() => ({ stderr: 'list failed', exitCode: 1 })),
    async ({ calls }) => {
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);

      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          'simctl status_bar sim-1 clear',
          `simctl status_bar sim-1 override ${NORMALIZE_ARGS}`,
          'simctl status_bar sim-1 clear',
        ],
      );
    },
  );
});

test('withNormalizedSimulatorStatusBar skips the snapshot read for back-to-back captures of a cleared status bar', async () => {
  await withFakeAppleTool(
    statusBarScript(() => 'Current Status Bar Overrides:\n============================='),
    async ({ calls }) => {
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);

      assert.deepEqual(
        calls.map((args) => args.join(' ')),
        [
          'simctl status_bar sim-1 list',
          `simctl status_bar sim-1 override ${NORMALIZE_ARGS}`,
          'simctl status_bar sim-1 clear',
          `simctl status_bar sim-1 override ${NORMALIZE_ARGS}`,
          'simctl status_bar sim-1 clear',
        ],
      );
    },
  );
});

test('a failed status bar snapshot logs snapshot_failed with the tool failure', async () => {
  const events = await statusBarDiagnosticEvents(async () => {
    await withFakeAppleTool(
      statusBarScript(() => ({ stderr: 'list failed', exitCode: 1 })),
      async () => {
        await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);
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

test('a failed status bar restore logs restore_failed and keeps the capture result', async () => {
  const events = await statusBarDiagnosticEvents(async () => {
    await withFakeAppleTool(
      (args) => {
        if (args[3] === 'list') return STATUS_BAR_OVERRIDES_LISTING;
        if (args[3] === 'clear') {
          return new AppError('COMMAND_FAILED', 'clear rejected', {
            exitCode: 8,
            stderr: 'clear rejected',
          });
        }
        return '';
      },
      async () => {
        assert.equal(
          await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture),
          'captured',
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
        reason: 'clear rejected',
        exitCode: 8,
        stderr: 'clear rejected',
      },
    },
    {
      level: 'warn',
      phase: 'ios_screenshot_status_bar_restore_failed',
      data: {
        platform: 'apple',
        deviceKind: 'simulator',
        deviceId: 'sim-1',
        errorCode: 'COMMAND_FAILED',
        reason: 'clear rejected',
        exitCode: 8,
        stderr: 'clear rejected',
      },
    },
  ]);
});

test('a failed status bar restore leaves no known-cleared answer for the next capture', async () => {
  // "This simulator holds no overrides" is only true once a restore's `clear` actually completed.
  // When it fails, the simulator holds whatever the failed command left, so the next capture must
  // read the bar again instead of trusting that answer and normalizing without a clear.
  const CLEARED_LISTING = 'Current Status Bar Overrides:\n=============================';
  let clearAttempts = 0;
  await withFakeAppleTool(
    (args) => {
      if (args[3] === 'list') return CLEARED_LISTING;
      if (args[3] === 'clear') {
        clearAttempts += 1;
        if (clearAttempts === 1) return '';
        return new AppError('COMMAND_FAILED', 'clear timed out', {
          exitCode: 1,
          stderr: 'clear timed out',
        });
      }
      return '';
    },
    async ({ calls }) => {
      // First capture: a clean restore earns the known-cleared answer.
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);
      calls.length = 0;
      // Second capture: its restore fails, and that answer has to go with it.
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);
      calls.length = 0;
      await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);

      assert.equal(calls[0]?.join(' '), 'simctl status_bar sim-1 list');
    },
  );
});

test('a failed status bar override logs prepare_failed and the capture still runs', async () => {
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
        const captured = await withNormalizedSimulatorStatusBar(IOS_TEST_SIMULATOR, capture);
        assert.equal(captured, 'captured');
        assert.equal(calls.at(-1)?.join(' '), 'simctl status_bar sim-1 clear');
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
