import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import { captureSimulatorScreenshotWithFallback } from '../screenshot.ts';
import { invalidateSimulatorStatusBarOverrideCache } from '../screenshot-status-bar.ts';
import {
  createFakeStatusBarSimctl,
  type FakeStatusBarSimctl,
  type StatusBarOverrideState,
} from './fake-status-bar-simctl.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

/**
 * Two captures that overlap on one simulator. The normalization a capture applies is temporary, so
 * a capture must never read it back as the state to restore to, and it must never leave it behind.
 *
 * These run through the capture route with the status bar owner's real implementation: the only
 * seam they replace is the capture itself, so a gate can hold one capture open while another starts.
 */

/** The caller's own override, the state both captures must leave behind. */
const CALLER_OVERRIDES: StatusBarOverrideState = {
  dataNetwork: 'hide',
  wifiMode: 'failed',
  wifiBars: '0',
  cellularMode: 'failed',
  cellularBars: '0',
  operatorName: 'No Service',
};

/** The normalization, which is what the tool reports while a capture is in flight. */
const NORMALIZED_OVERRIDES: StatusBarOverrideState = {
  time: '9:41',
  dataNetwork: 'wifi',
  wifiMode: 'active',
  wifiBars: '3',
  batteryState: 'charged',
  batteryLevel: '100',
};

/** Holds one capture open until the test releases it, so the overlap is the test's, not the host's. */
function createCaptureGate() {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    capture: async (): Promise<void> => {
      markEntered();
      await released;
    },
  };
}

/**
 * Everything a simulator capture needs except the status bar, which stays the real owner so these
 * cases exercise the same status bar commands the route sends on a device.
 */
function captureDeps(captureWithRetry: (device: DeviceInfo) => Promise<void>) {
  return {
    resolveCaptureTarget: async () => ({}) as const,
    captureWithRetry,
    normalizeDensity: async () => {},
    captureWithRunner: async () => undefined,
    shouldFallbackToRunner: () => false,
  };
}

function screenshotFailure(): AppError {
  return new AppError('COMMAND_FAILED', 'simctl screenshot failed', {
    stderr: 'Unable to capture screenshot',
    exitCode: 60,
  });
}

/** Lets the second capture reach the point where it would read the first capture's state. */
async function yieldToQueuedWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  invalidateSimulatorStatusBarOverrideCache(IOS_TEST_SIMULATOR);
});

test('overlapping simulator captures both restore the caller status bar overrides', async () => {
  const statusBar: FakeStatusBarSimctl = createFakeStatusBarSimctl(
    IOS_TEST_SIMULATOR.id,
    CALLER_OVERRIDES,
  );
  const firstGate = createCaptureGate();
  const secondGate = createCaptureGate();

  await withFakeAppleTool(statusBar.script, async () => {
    const first = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/first.png', {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(() => firstGate.capture()),
    });
    await firstGate.entered;

    const second = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/second.png', {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(() => secondGate.capture()),
    });
    try {
      await yieldToQueuedWork();

      firstGate.release();
      await first;
      secondGate.release();
      await second;
    } finally {
      // A capture that never reached its gate would keep the simulator's lock and hang every
      // later case in this file, hiding the failure the test is here to report.
      firstGate.release();
      secondGate.release();
    }

    assert.deepEqual(
      statusBar.overrides(),
      CALLER_OVERRIDES,
      'the second capture must restore the caller overrides, not the normalization it snapshotted',
    );
    assert.deepEqual(
      statusBar.servedSnapshots(),
      [CALLER_OVERRIDES, CALLER_OVERRIDES],
      "the second capture must snapshot the caller overrides, not the first capture's normalization",
    );
  });
});

test('a failed simulator capture restores the caller overrides and lets the queued capture finish', async () => {
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const firstGate = createCaptureGate();
  const secondGate = createCaptureGate();

  await withFakeAppleTool(statusBar.script, async () => {
    const first = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/first.png', {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(async () => {
        await firstGate.capture();
        throw screenshotFailure();
      }),
    });
    await firstGate.entered;

    const second = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/second.png', {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(() => secondGate.capture()),
    });
    let firstError: unknown;
    try {
      await yieldToQueuedWork();

      firstGate.release();
      firstError = await first.then(
        () => undefined,
        (error: unknown) => error,
      );
      secondGate.release();
      await second;
    } finally {
      firstGate.release();
      secondGate.release();
    }

    assert.ok(
      firstError instanceof AppError,
      `expected an AppError, received: ${String(firstError)}`,
    );
    assert.equal((firstError as AppError).code, 'COMMAND_FAILED');
    assert.equal((firstError as AppError).message, 'simctl screenshot failed');

    assert.deepEqual(statusBar.overrides(), CALLER_OVERRIDES);
    assert.deepEqual(
      statusBar.servedSnapshots(),
      [CALLER_OVERRIDES, CALLER_OVERRIDES],
      'the capture queued behind a failing capture snapshots the caller overrides as well',
    );
  });
});

test('a single simulator capture normalizes while it captures and restores afterwards', async () => {
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const seenDuringCapture: StatusBarOverrideState[] = [];

  await withFakeAppleTool(statusBar.script, async () => {
    await captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/out.png', {
      env: process.env,
      normalizeStatusBar: true,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(async () => {
        seenDuringCapture.push(statusBar.overrides());
      }),
    });

    assert.deepEqual(seenDuringCapture, [NORMALIZED_OVERRIDES]);
    assert.deepEqual(statusBar.overrides(), CALLER_OVERRIDES);
  });
});

test('a plain simulator capture waits for the normalization window instead of capturing it', async () => {
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const normalizingGate = createCaptureGate();
  const seenDuringPlainCapture: StatusBarOverrideState[] = [];

  await withFakeAppleTool(statusBar.script, async () => {
    const normalizing = captureSimulatorScreenshotWithFallback(
      IOS_TEST_SIMULATOR,
      '/tmp/normalized.png',
      {
        env: process.env,
        normalizeStatusBar: true,
        skipIosSimulatorBootCheck: true,
        deps: captureDeps(() => normalizingGate.capture()),
      },
    );
    await normalizingGate.entered;

    const plain = captureSimulatorScreenshotWithFallback(IOS_TEST_SIMULATOR, '/tmp/plain.png', {
      env: process.env,
      skipIosSimulatorBootCheck: true,
      deps: captureDeps(async () => {
        seenDuringPlainCapture.push(statusBar.overrides());
      }),
    });
    try {
      await yieldToQueuedWork();

      normalizingGate.release();
      await normalizing;
      await plain;
    } finally {
      normalizingGate.release();
    }

    assert.deepEqual(
      seenDuringPlainCapture,
      [CALLER_OVERRIDES],
      'a capture without --normalize-status-bar must not take its screenshot of the temporary normalized bar',
    );
  });
});
