import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';

// `setIosSetting` boots through this owner; the capture route under test skips it, so the settings
// case below needs it quiet without touching the status bar owner.
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: async () => {} };
});

import { setIosSetting } from '../app-settings.ts';
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

type CaptureGate = ReturnType<typeof createCaptureGate>;

/** Everything a simulator capture needs except the status bar, which stays the real owner so these
 * cases exercise the same status bar commands the route sends on a device. */
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

function screenshotOptions(
  gate: CaptureGate,
  normalizeStatusBar: boolean,
  options: { readDuringCapture?: () => void; failsAfterGate?: boolean } = {},
) {
  return {
    env: process.env,
    normalizeStatusBar,
    skipIosSimulatorBootCheck: true,
    deps: captureDeps(async () => {
      // The read happens at the top of the capture step: that is the state this capture's image
      // is taken with, and it is the only moment the status bar owner has it.
      options.readDuringCapture?.();
      await gate.capture();
      if (options.failsAfterGate === true) {
        throw screenshotFailure();
      }
    }),
  } as const;
}

/**
 * Runs a body that starts two captures on one simulator and hands back both settled. Gates are
 * released and both captures are observed whatever the body threw: a capture left holding the
 * simulator's lock would hang the later cases in this file, and a rejection nobody awaited would
 * fail one of them instead of the case that caused it.
 */
async function withOverlappingCaptures(
  start: () => Promise<{ captures: Array<Promise<unknown>>; gates: CaptureGate[] }>,
  run: (settled: PromiseSettledResult<unknown>[]) => void,
): Promise<void> {
  let captures: Array<Promise<unknown>> = [];
  let gates: CaptureGate[] = [];
  let settled: PromiseSettledResult<unknown>[] = [];
  try {
    const started = await start();
    captures = started.captures;
    gates = started.gates;
    await yieldToQueuedWork();
    for (const gate of gates) gate.release();
    settled = await Promise.allSettled(captures);
  } finally {
    for (const gate of gates) gate.release();
    settled = await Promise.allSettled(captures);
  }
  run(settled);
}

function fulfilledCount(settled: PromiseSettledResult<unknown>[]): number {
  return settled.filter((result) => result.status === 'fulfilled').length;
}

function rejectionReason(settled: PromiseSettledResult<unknown>[], index: number): unknown {
  const result = settled[index];
  if (result?.status !== 'rejected') {
    throw new assert.AssertionError({ message: `expected capture ${index} to reject` });
  }
  return result.reason;
}

beforeEach(() => {
  invalidateSimulatorStatusBarOverrideCache(IOS_TEST_SIMULATOR);
});

test('overlapping simulator captures both restore the caller status bar overrides', async () => {
  const statusBar: FakeStatusBarSimctl = createFakeStatusBarSimctl(
    IOS_TEST_SIMULATOR.id,
    CALLER_OVERRIDES,
  );

  await withFakeAppleTool(statusBar.script, async () => {
    await withOverlappingCaptures(
      async () => {
        const firstGate = createCaptureGate();
        const secondGate = createCaptureGate();
        const first = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/first.png',
          screenshotOptions(firstGate, true),
        );
        await firstGate.entered;
        const second = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/second.png',
          screenshotOptions(secondGate, true),
        );
        return { captures: [first, second], gates: [firstGate, secondGate] };
      },
      (settled) => {
        assert.equal(fulfilledCount(settled), 2, 'both captures must finish');
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
      },
    );
  });
});

test('a failed simulator capture restores the caller overrides and lets the queued capture finish', async () => {
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);

  await withFakeAppleTool(statusBar.script, async () => {
    await withOverlappingCaptures(
      async () => {
        const firstGate = createCaptureGate();
        const secondGate = createCaptureGate();
        const first = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/first.png',
          screenshotOptions(firstGate, true, { failsAfterGate: true }),
        );
        await firstGate.entered;
        const second = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/second.png',
          screenshotOptions(secondGate, true),
        );
        return { captures: [first, second], gates: [firstGate, secondGate] };
      },
      (settled) => {
        const error = rejectionReason(settled, 0);
        assert.ok(error instanceof AppError, `expected an AppError, received: ${String(error)}`);
        assert.equal((error as AppError).code, 'COMMAND_FAILED');
        assert.equal((error as AppError).message, 'simctl screenshot failed');
        assert.equal(settled[1]?.status, 'fulfilled', 'the queued capture must still finish');

        assert.deepEqual(statusBar.overrides(), CALLER_OVERRIDES);
        assert.deepEqual(
          statusBar.servedSnapshots(),
          [CALLER_OVERRIDES, CALLER_OVERRIDES],
          'the capture queued behind a failing capture snapshots the caller overrides as well',
        );
      },
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

test('an already-aborted request does not start a plain simulator capture', async () => {
  // Since the plain path takes the window it also honours the request's cancellation: a request the
  // caller gave up on stops before it does device work nobody will read.
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const abortController = new AbortController();
  abortController.abort(new Error('request canceled'));
  let captureStarted = false;

  await withFakeAppleTool(statusBar.script, async () => {
    const options = screenshotOptions(createCaptureGate(), false);
    const settled = await captureSimulatorScreenshotWithFallback(
      IOS_TEST_SIMULATOR,
      '/tmp/aborted.png',
      {
        ...options,
        deps: {
          ...options.deps,
          captureWithRetry: async () => {
            captureStarted = true;
          },
        },
        runnerOptions: { signal: abortController.signal },
      },
    ).then(
      () => 'fulfilled',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    assert.equal(settled, 'request canceled');
    assert.equal(captureStarted, false);
  });
});

test('an aborted request leaves the queue behind another request on the same simulator', async () => {
  // Dropping the signal for a holder's own nested leg must stay caller-scoped: another request that
  // merely shares the simulator keeps its cancellation, so it leaves the queue when its own caller
  // gives up instead of waiting for the holder to finish.
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const holderGate = createCaptureGate();
  const abortController = new AbortController();

  await withFakeAppleTool(statusBar.script, async () => {
    const holder = captureSimulatorScreenshotWithFallback(
      IOS_TEST_SIMULATOR,
      '/tmp/holder.png',
      screenshotOptions(holderGate, true),
    );
    await holderGate.entered;

    let queuedCaptureStarted = false;
    const queued = captureSimulatorScreenshotWithFallback(
      IOS_TEST_SIMULATOR,
      '/tmp/aborted-queue.png',
      {
        env: process.env,
        normalizeStatusBar: false,
        skipIosSimulatorBootCheck: true,
        deps: captureDeps(async () => {
          queuedCaptureStarted = true;
        }),
        runnerOptions: { signal: abortController.signal },
      },
    ).catch((error: unknown) => error);

    await yieldToQueuedWork();
    abortController.abort(new Error('request canceled'));
    const outcome = await queued;
    holderGate.release();
    await holder;

    assert.ok(
      outcome instanceof Error && outcome.message === 'request canceled',
      `expected the queued capture to reject with the abort reason, received: ${String(outcome)}`,
    );
    assert.equal(queuedCaptureStarted, false, 'the aborted capture must not reach the device');
  });
});

test('a settings write to the status bar waits for the capture window', async () => {
  // Its own simulator id: a lock this case leaves held must never make a later case wait for it.
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, id: 'sim-bar-writer' };
  invalidateSimulatorStatusBarOverrideCache(device);
  const statusBar = createFakeStatusBarSimctl(device.id, { wifiMode: 'failed', wifiBars: '0' });

  await withFakeAppleTool(
    (args) => statusBar.script(args),
    async ({ calls }) => {
      const gate = createCaptureGate();
      const capturing = captureSimulatorScreenshotWithFallback(
        device,
        '/tmp/normalized.png',
        screenshotOptions(gate, true),
      );
      let settingDone = false;
      let setting: Promise<unknown> = Promise.resolve();
      try {
        await gate.entered;
        setting = setIosSetting(device, 'wifi', 'on', undefined, undefined, process.env).then(
          () => {
            settingDone = true;
          },
        );
        await yieldToQueuedWork();
        assert.equal(settingDone, false, 'a status bar write must wait for the capture window');
      } finally {
        gate.release();
        await Promise.allSettled([capturing, setting]);
      }

      // The write lands after the capture restored the bar the caller had, so that restore cannot
      // revert a setting the caller asked for while the capture was running.
      assert.deepEqual(
        calls.map((args) => args.join(' ')).at(-1),
        'simctl status_bar sim-bar-writer override --wifiMode active',
      );
      assert.deepEqual(statusBar.overrides(), { wifiMode: 'active', wifiBars: '0' });
    },
  );
});

test('a settings write queued behind a capture window can still be cancelled', async () => {
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, id: 'sim-bar-cancel' };
  invalidateSimulatorStatusBarOverrideCache(device);
  const statusBar = createFakeStatusBarSimctl(device.id, { wifiMode: 'failed', wifiBars: '0' });
  const abortController = new AbortController();

  await withFakeAppleTool(statusBar.script, async () => {
    const gate = createCaptureGate();
    const capturing = captureSimulatorScreenshotWithFallback(
      device,
      '/tmp/normalized.png',
      screenshotOptions(gate, true),
    );
    let outcome: unknown = 'still running';
    try {
      await gate.entered;
      const setting = setIosSetting(
        device,
        'wifi',
        'on',
        undefined,
        undefined,
        process.env,
        abortController.signal,
      ).catch((error: unknown) => error);
      await yieldToQueuedWork();
      abortController.abort(new Error('request canceled'));
      outcome = await setting;
      assert.ok(
        outcome instanceof Error && outcome.message === 'request canceled',
        `expected the queued write to reject, received: ${String(outcome)}`,
      );
    } finally {
      gate.release();
      await Promise.allSettled([capturing]);
    }

    assert.deepEqual(statusBar.overrides(), { wifiMode: 'failed', wifiBars: '0' });
  });
});

test('simulators of different device sets keep their own status bar windows', async () => {
  // `simctl status_bar` is scoped with `--set`, so one udid in two sets is two bars. Records that
  // name one simulator — same udid and same set — share a window; different sets must not queue.
  const entered: string[] = [];
  const gates = { one: createCaptureGate(), two: createCaptureGate() };
  const deviceFor = (tag: keyof typeof gates): DeviceInfo => ({
    ...IOS_TEST_SIMULATOR,
    simulatorSetPath: `/sets/${tag}`,
  });

  await withFakeAppleTool(
    (args) => {
      // The `--set` scope lands before `status_bar`, so locate the verb rather than a fixed index.
      const index = args.indexOf('status_bar');
      if (index === -1) return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
      const verb = args[index + 2];
      return verb === 'list' ? 'Current Status Bar Overrides:\n=============================' : '';
    },
    async () => {
      const captureFor = (tag: keyof typeof gates) =>
        captureSimulatorScreenshotWithFallback(deviceFor(tag), `/tmp/${tag}.png`, {
          env: process.env,
          normalizeStatusBar: true,
          skipIosSimulatorBootCheck: true,
          deps: captureDeps(async () => {
            entered.push(tag);
            await gates[tag].capture();
          }),
        });

      const first = captureFor('one');
      await gates.one.entered;
      const second = captureFor('two');
      try {
        await yieldToQueuedWork();
        // Both capture steps run at once: the second set never queued behind the first.
        assert.deepEqual(entered, ['one', 'two']);
      } finally {
        gates.one.release();
        gates.two.release();
        await Promise.allSettled([first, second]);
      }
    },
  );
});

test('a plain simulator capture waits for the normalization window instead of capturing it', async () => {
  const statusBar = createFakeStatusBarSimctl(IOS_TEST_SIMULATOR.id, CALLER_OVERRIDES);
  const seenDuringPlainCapture: StatusBarOverrideState[] = [];

  await withFakeAppleTool(statusBar.script, async () => {
    await withOverlappingCaptures(
      async () => {
        const normalizingGate = createCaptureGate();
        const plainGate = createCaptureGate();
        const normalizing = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/normalized.png',
          screenshotOptions(normalizingGate, true),
        );
        await normalizingGate.entered;
        const plain = captureSimulatorScreenshotWithFallback(
          IOS_TEST_SIMULATOR,
          '/tmp/plain.png',
          screenshotOptions(plainGate, false, {
            readDuringCapture: () => {
              seenDuringPlainCapture.push(statusBar.overrides());
            },
          }),
        );
        return { captures: [normalizing, plain], gates: [normalizingGate, plainGate] };
      },
      (settled) => {
        assert.equal(fulfilledCount(settled), 2, 'both captures must finish');
        assert.deepEqual(
          seenDuringPlainCapture,
          [CALLER_OVERRIDES],
          'a capture without --normalize-status-bar must not take its screenshot of the temporary normalized bar',
        );
      },
    );
  });
});
