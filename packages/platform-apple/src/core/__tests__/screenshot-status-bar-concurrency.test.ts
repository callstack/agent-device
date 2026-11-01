import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

// `setIosSetting` boots through this owner; the capture route under test skips it, so the settings
// case below needs it quiet without touching the status bar owner.
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: async () => {} };
});

import { setIosSetting } from '../app-settings.ts';
import { captureSimulatorScreenshotWithFallback } from '../screenshot.ts';
import {
  invalidateSimulatorStatusBarOverrideCache,
  STATUS_BAR_COMMAND_TIMEOUT_MS,
} from '../screenshot-status-bar.ts';
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

/** What `simctl status_bar <udid> list` answers when the simulator holds no overrides. */
const CLEARED_STATUS_BAR_LISTING = 'Current Status Bar Overrides:\n=============================';

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
    // Released before the wait: if the cancellation were ignored, the write finishes and the
    // assertion below reports that, instead of the case hanging on the gate until its timeout.
    gate.release();
    outcome = await setting;
    await capturing;

    assert.ok(
      outcome instanceof Error && outcome.message === 'request canceled',
      `expected the queued write to reject, received: ${String(outcome)}`,
    );
    assert.deepEqual(statusBar.overrides(), { wifiMode: 'failed', wifiBars: '0' });
  });
});

test('a settings write bounds its status bar command like a capture does', async () => {
  // The write holds the simulator's window, so a wedged `simctl status_bar` inside it would hold
  // every later capture of that simulator. It keeps the same per-command budget the capture's own
  // status bar commands use.
  const budgets: Array<number | undefined> = [];
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, id: 'sim-bar-budget' };
  invalidateSimulatorStatusBarOverrideCache(device);

  await withAppleToolProvider(
    createLocalAppleToolProvider({
      simctl: {
        run: async (args, options) => {
          if (args.includes('status_bar')) budgets.push(options?.timeoutMs);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      },
    }),
    async () => {
      await setIosSetting(device, 'wifi', 'on', undefined, undefined, process.env);
      await setIosSetting(device, 'airplane', 'on', undefined, undefined, process.env);
      await setIosSetting(device, 'airplane', 'off', undefined, undefined, process.env);
    },
  );

  for (const budget of budgets) {
    assert.equal(typeof budget, 'number', 'a status bar write must bound its own command');
  }
  assert.deepEqual(budgets, [
    STATUS_BAR_COMMAND_TIMEOUT_MS,
    STATUS_BAR_COMMAND_TIMEOUT_MS,
    STATUS_BAR_COMMAND_TIMEOUT_MS,
  ]);
});

test('one simulator reached through two spellings of its device set keeps one window', async () => {
  // `simctl --set` follows aliases, so a symlinked or otherwise non-normalized spelling of one set
  // reaches the same status bar. Two windows over it would let a capture snapshot another capture's
  // normalization, which is the leak this owner exists to prevent.
  const setRoot = await mkdtempForTest('sm11-set-');
  const canonicalSet = await fs.realpath(setRoot);
  const aliasSet = path.join(canonicalSet, 'link-to-set');
  await fs.symlink(canonicalSet, aliasSet);

  const entered: string[] = [];
  const gates = { canonical: createCaptureGate(), alias: createCaptureGate() };
  const deviceFor = (tag: keyof typeof gates): DeviceInfo => ({
    ...IOS_TEST_SIMULATOR,
    simulatorSetPath: tag === 'canonical' ? canonicalSet : aliasSet,
  });

  await withFakeAppleTool(
    (args) => {
      const index = args.indexOf('status_bar');
      if (index === -1) return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
      return args[index + 2] === 'list' ? CLEARED_STATUS_BAR_LISTING : '';
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

      const canonical = captureFor('canonical');
      await gates.canonical.entered;
      const alias = captureFor('alias');
      try {
        await yieldToQueuedWork();
        // The aliased capture is still queued: both records address one simulator, so they share
        // one window and the second cannot snapshot the first capture's normalization.
        assert.deepEqual(entered, ['canonical']);
      } finally {
        gates.canonical.release();
        gates.alias.release();
        await Promise.allSettled([canonical, alias]);
      }

      assert.deepEqual(entered, ['canonical', 'alias']);
    },
  );
});

test('naming the default device set explicitly shares the default window', async () => {
  // `simctl --set <default root>` selects the same simulators as naming no set, so the two spellings
  // must not open two windows over one status bar.
  const entered: string[] = [];
  const gates = { implicit: createCaptureGate(), explicit: createCaptureGate() };
  // `os.homedir()` answers with `$HOME` on POSIX, which is how the owner derives this root.
  const home = process.env.HOME;
  assert.ok(home, 'the default device root needs a home directory');
  const defaultSet = path.join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  const deviceFor = (tag: keyof typeof gates): DeviceInfo => ({
    ...IOS_TEST_SIMULATOR,
    simulatorSetPath: tag === 'explicit' ? defaultSet : undefined,
  });

  await withFakeAppleTool(
    (args) => {
      const index = args.indexOf('status_bar');
      if (index === -1) return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
      return args[index + 2] === 'list' ? CLEARED_STATUS_BAR_LISTING : '';
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

      const implicit = captureFor('implicit');
      await gates.implicit.entered;
      const explicit = captureFor('explicit');
      try {
        await yieldToQueuedWork();
        assert.deepEqual(entered, ['implicit']);
      } finally {
        gates.implicit.release();
        gates.explicit.release();
        await Promise.allSettled([implicit, explicit]);
      }

      assert.deepEqual(entered, ['implicit', 'explicit']);
    },
  );
});

test('a timed-out settings write forces the next capture to read the bar again', async () => {
  // A command that hits its deadline may still have reached `simctl`, so a write that times out
  // cannot leave a cached answer about the bar behind: the next capture has to read what the write
  // applied, or it would normalize over a setting the caller asked for and restore without it.
  const device: DeviceInfo = { ...IOS_TEST_SIMULATOR, id: 'sim-bar-timeout' };
  invalidateSimulatorStatusBarOverrideCache(device);
  const statusBar = createFakeStatusBarSimctl(device.id, {});
  let timeoutApplied = false;

  await withFakeAppleTool(
    (args) => {
      const response = statusBar.script(args);
      // The settings write is the override that names only `--wifiMode`: a capture's normalization
      // and its restore both name the other fields.
      const lastOption = args.at(-2);
      if (args.includes('--wifiMode') && lastOption === '--wifiMode' && !timeoutApplied) {
        timeoutApplied = true;
        return new AppError('COMMAND_FAILED', 'xcrun timed out after 10000ms', { exitCode: 1 });
      }
      return response;
    },
    async ({ calls }) => {
      // A capture with nothing on the bar earns the answer that the bar is cleared.
      await captureSimulatorScreenshotWithFallback(device, '/tmp/cleared.png', {
        env: process.env,
        normalizeStatusBar: true,
        skipIosSimulatorBootCheck: true,
        deps: captureDeps(async () => {}),
      });
      calls.length = 0;

      await setIosSetting(device, 'wifi', 'on', undefined, undefined, process.env).then(
        () => assert.fail('expected the write to time out'),
        (error: unknown) =>
          assert.match(String((error as Error).message), /timed out/, 'the timeout must surface'),
      );
      assert.deepEqual(
        statusBar.overrides(),
        { wifiMode: 'active' },
        'the write reached the simulator before its deadline',
      );
      calls.length = 0;

      await captureSimulatorScreenshotWithFallback(device, '/tmp/after-timeout.png', {
        env: process.env,
        normalizeStatusBar: true,
        skipIosSimulatorBootCheck: true,
        deps: captureDeps(async () => {}),
      });

      assert.equal(
        calls[0]?.join(' '),
        `simctl status_bar ${device.id} list`,
        'a capture after a timed-out write must read the bar, not trust a cached answer',
      );
      assert.deepEqual(
        statusBar.overrides(),
        // `simctl` reports a Wi-Fi mode together with a bars count, so the snapshot the capture
        // restores from names both once the timed-out write has applied the mode.
        { wifiMode: 'active', wifiBars: '0' },
        'the capture must restore the setting the timed-out write applied',
      );
    },
  );
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
