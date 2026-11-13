import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { bindTestCommandHost } from '@agent-device/test-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import type { ExecResult } from '@agent-device/host-kit/command';

bindTestCommandHost();

// Only the boot owner's own work stands in for the boot: the recovery decision, the state probe,
// and the `simctl list devices -j` reader behind it all run for real, over scripted host commands.
vi.mock('../simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../simulator.ts')>();
  return { ...actual, ensureBootedSimulator: vi.fn(actual.ensureBootedSimulator) };
});
vi.mock('../screenshot-status-bar.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenshot-status-bar.ts')>();
  return {
    ...actual,
    withSimulatorStatusBarHeld: vi.fn(async (_device, capture: () => unknown) => await capture()),
    withNormalizedSimulatorStatusBar: vi.fn(
      async (_device, capture: () => unknown) => await capture(),
    ),
  };
});

import { ensureBootedSimulator } from '../simulator.ts';
import { captureSimulatorScreenshotWithFallback } from '../screenshot.ts';
import { SIMCTL_SCREENSHOT_TIMEOUT_REASON } from '../tool-provider.ts';
import {
  IOS_SIMCTL_LIST_TIMEOUT_MS,
  IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS,
} from '../config.ts';
import {
  commandFailed,
  commandStdout,
  isSimctlListDevices,
  withScriptedCommands,
  type ScriptedCommandCall,
} from './scripted-command-executor.ts';

/**
 * The skipped-boot-check recovery: a failed simulator capture may boot its simulator only when the
 * tool answers that the simulator is turned off right now.
 *
 * The trigger is the `state` field of `simctl list devices -j` — the same field the shutdown owner
 * compares against the same literal — so the capture's own wording selects nothing.
 */

/** The failure the capture step reports, exactly as the local simctl adapter reports a protocol
 * timeout: its typed reason beside the tool's own header. The wording is never a boot authorization;
 * the observed state is. */
const CAPTURE_FAILURE = new AppError('COMMAND_FAILED', 'xcrun exited with code 60', {
  stderr:
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\n' +
    'Timeout waiting for screen surfaces',
  exitCode: 60,
  processExitError: true,
  hint: 'Capture stderr excerpt preserved for the operator.',
  reason: SIMCTL_SCREENSHOT_TIMEOUT_REASON,
});

function listingFor(udid: string, state: string): ExecResult {
  return commandStdout(
    JSON.stringify({
      devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid, state }] },
    }),
  );
}

type RecoveryProbe = {
  error: unknown;
  stateReads: ScriptedCommandCall[];
  captureAttempts: number;
  runnerCaptures: number;
  boots: number;
};

/**
 * Runs the capture route over the real flow with a failing capture step. The host commands, the
 * probe and its JSON reader are the production ones; only the capture step and the boot owner's own
 * booting work are held still.
 */
async function probeRecovery(
  device: DeviceInfo,
  options: {
    state?: (call: ScriptedCommandCall) => ExecResult;
    captureError?: unknown | ((attempt: number) => unknown);
    signal?: AbortSignal;
    skipIosSimulatorBootCheck?: boolean;
    /** The fallback decision the flow makes after recovery; the production one is the timeout reason. */
    shouldFallbackToRunner?: (error: unknown) => boolean;
  } = {},
): Promise<RecoveryProbe> {
  const boot = vi.mocked(ensureBootedSimulator);
  boot.mockReset();
  boot.mockResolvedValue(undefined);
  let captureAttempts = 0;
  let runnerCaptures = 0;
  const fallbackToRunner = options.shouldFallbackToRunner ?? (() => false);

  return await withScriptedCommands(
    (call) => options.state?.(call) ?? commandStdout(''),
    async (executor) => {
      const error = await captureSimulatorScreenshotWithFallback(device, '/tmp/out.png', {
        env: process.env,
        skipIosSimulatorBootCheck: options.skipIosSimulatorBootCheck ?? true,
        runnerOptions: options.signal ? { signal: options.signal } : undefined,
        deps: {
          captureWithRetry: async () => {
            captureAttempts += 1;
            const failure = options.captureError;
            throw typeof failure === 'function'
              ? (failure as (attempt: number) => unknown)(captureAttempts)
              : (failure ?? CAPTURE_FAILURE);
          },
          captureWithRunner: async () => {
            runnerCaptures += 1;
            return undefined;
          },
          normalizeDensity: async () => {},
          resolveCaptureTarget: async () => ({}),
          shouldFallbackToRunner: fallbackToRunner,
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return {
        error,
        stateReads: executor.calls().filter(isSimctlListDevices),
        captureAttempts,
        runnerCaptures,
        boots: boot.mock.calls.length,
      };
    },
  );
}

function simulator(id: string): DeviceInfo {
  return { platform: 'apple', id, name: 'iPhone 17 Pro', kind: 'simulator' };
}

beforeEach(() => {
  vi.mocked(ensureBootedSimulator).mockReset();
  vi.mocked(ensureBootedSimulator).mockResolvedValue(undefined);
});

test('a fresh Shutdown answer boots the skipped-check simulator once and re-captures once', async () => {
  const device = simulator('sim-recover-shutdown');
  const probe = await probeRecovery(device, { state: () => listingFor(device.id, 'Shutdown') });

  assert.equal(probe.boots, 1, 'one boot attempt authorized by the observed state');
  assert.equal(probe.captureAttempts, 2, 'one capture, then one re-capture after the boot');
  assert.equal(probe.stateReads.length, 1, 'one state observation per failed capture');
  assert.equal(
    probe.runnerCaptures,
    0,
    'the recovery re-captures through the same simctl route, not the runner',
  );
});

test('the re-capture that fails again reports its own failure and adds no second recovery', async () => {
  const device = simulator('sim-recover-recapture-fails');
  const recaptureFailure = new AppError('COMMAND_FAILED', 'xcrun exited with code 71', {
    exitCode: 71,
  });
  const probe = await probeRecovery(device, {
    state: () => listingFor(device.id, 'Shutdown'),
    captureError: (attempt: number) => (attempt === 1 ? CAPTURE_FAILURE : recaptureFailure),
  });

  assert.equal(probe.captureAttempts, 2);
  assert.equal(probe.boots, 1, 'a failed re-capture does not boot again');
  assert.equal(probe.stateReads.length, 1, 'the recovery observes the state once');
  assert.equal(probe.error, recaptureFailure, 'the re-capture failure is what the caller sees');
});

test.each(['Booted', 'Booting', 'Creating', 'Shutting Down', 'Living'] as const)(
  'a simulator listed as %s is not turned off, so nothing boots or re-captures',
  async (state) => {
    const device = simulator(`sim-recover-${state.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    const probe = await probeRecovery(device, { state: () => listingFor(device.id, state) });

    assert.equal(probe.stateReads.length, 1, 'exactly one state observation');
    assert.equal(probe.boots, 0, 'no boot is authorized');
    assert.equal(probe.captureAttempts, 1, 'no re-capture starts');
    assert.equal(probe.error, CAPTURE_FAILURE, 'the capture keeps its failure, unchanged');
  },
);

test('an unreadable, unlisted or stateless listing cannot authorize a boot', async () => {
  const unreadableAnswers: Array<[string, () => ExecResult]> = [
    [
      'a listing that failed',
      () => commandFailed('xcrun: error: unable to find utility "simctl"', 72),
    ],
    ['output that is not JSON', () => commandStdout('not json')],
    ['a listing that omits the simulator', () => commandStdout('{"devices":{}}')],
    [
      'an entry that names no state',
      () =>
        commandStdout(
          '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-6":[{"udid":"sim-unreadable"}]}}',
        ),
    ],
  ];

  for (const [label, answer] of unreadableAnswers) {
    const device = simulator(`sim-unreadable-${label.length}`);
    const probe = await probeRecovery(device, { state: answer });

    assert.equal(probe.boots, 0, `${label}: no boot from an answer that names no shutdown`);
    assert.equal(probe.captureAttempts, 1, `${label}: no re-capture may start`);
    assert.equal(probe.error, CAPTURE_FAILURE, `${label}: the original failure stands`);
    assert.equal(probe.runnerCaptures, 0, `${label}: no fallback is added`);
  }
});

test('a state read that itself fails keeps the capture failure and its diagnostics', async () => {
  const device = simulator('sim-recover-probe-throws');
  const probe = await probeRecovery(device, {
    state: () => {
      throw new Error('simctl list devices -j could not be spawned');
    },
  });

  assert.equal(probe.error, CAPTURE_FAILURE, 'a failed probe never replaces the capture failure');
  assert.equal(probe.boots, 0);
  assert.equal(probe.captureAttempts, 1);
  const details = (CAPTURE_FAILURE.details ?? {}) as Record<string, unknown>;
  assert.equal(details.exitCode, 60);
  assert.equal(details.processExitError, true);
  assert.equal(typeof details.hint, 'string', 'the hint the producer attached is preserved');
});

test('the recovery probe is bounded by the screenshot ceiling, not the inventory budget', async () => {
  const device = simulator('sim-recover-budget');
  const probe = await probeRecovery(device, { state: () => listingFor(device.id, 'Shutdown') });

  const [onlyProbe] = probe.stateReads;
  assert.ok(onlyProbe, 'the recovery reads the boot state once');
  assert.equal(
    onlyProbe.options.timeoutMs,
    IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS,
    'the probe runs under the screenshot-owned ceiling',
  );
  assert.ok(
    IOS_SIMULATOR_SCREENSHOT_STATE_PROBE_TIMEOUT_MS < IOS_SIMCTL_LIST_TIMEOUT_MS,
    'the probe must not inherit the 60s inventory budget behind a 20s capture',
  );
});

test('an already canceled request never reaches the probe', async () => {
  const device = simulator('sim-recover-canceled');
  // The cancellation a request carries is the typed one the capture route raises it with.
  const cancellation = createRequestCanceledError({ cmd: 'xcrun' });
  const abortController = new AbortController();
  abortController.abort(cancellation);

  const probe = await probeRecovery(device, {
    signal: abortController.signal,
    state: () => listingFor(device.id, 'Shutdown'),
  });

  assert.equal(probe.stateReads.length, 0, 'a canceled request must not query the device');
  assert.equal(probe.boots, 0);
  assert.equal(probe.captureAttempts, 1);
  assert.equal(probe.runnerCaptures, 0);
  assert.equal(probe.error, cancellation, 'the cancellation stays the reported failure');
});

test('a cancellation that arrives with the capture failure is not treated as an unknown state', async () => {
  const device = simulator('sim-recover-canceled-error');
  const cancellation = createRequestCanceledError({ cmd: 'xcrun' });
  const probe = await probeRecovery(device, {
    captureError: cancellation,
    // Even a Shutdown answer may not turn a canceled request into a boot.
    state: () => listingFor(device.id, 'Shutdown'),
  });

  assert.equal(probe.error, cancellation, 'the typed cancellation is what the caller sees');
  assert.equal(probe.stateReads.length, 0, 'a cancellation never reaches the probe');
  assert.equal(probe.boots, 0);
  assert.equal(probe.captureAttempts, 1);
});

test('a cancellation raised by the probe travels on instead of answering no', async () => {
  const device = simulator('sim-recover-probe-canceled');
  const cancellation = createRequestCanceledError({ cmd: 'xcrun' });
  const probe = await probeRecovery(device, {
    captureError: CAPTURE_FAILURE,
    state: () => {
      throw cancellation;
    },
  });

  assert.equal(probe.error, cancellation, 'the probe must not swallow a cancellation');
  assert.equal(probe.boots, 0);
  assert.equal(probe.captureAttempts, 1);
});

test('a capture that did not skip the boot check never probes the state', async () => {
  const device = simulator('sim-recover-no-skip');
  const probe = await probeRecovery(device, {
    skipIosSimulatorBootCheck: false,
    state: () => listingFor(device.id, 'Shutdown'),
  });

  assert.equal(probe.stateReads.length, 0);
  assert.equal(probe.captureAttempts, 1);
});

test('a mask-bearing capture that observed a shutdown still refuses the runner fallback', async () => {
  const device = simulator('sim-recover-mask');
  const probe = await withScriptedCommands(
    () => listingFor(device.id, 'Shutdown'),
    async (executor) => {
      const error = await captureSimulatorScreenshotWithFallback(device, '/tmp/out.png', {
        env: process.env,
        screenMask: 'black',
        skipIosSimulatorBootCheck: true,
        deps: {
          captureWithRetry: async () => {
            throw CAPTURE_FAILURE;
          },
          normalizeDensity: async () => {},
          resolveCaptureTarget: async () => ({}),
          captureWithRunner: async () => undefined,
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      return { error, stateReads: executor.calls().filter(isSimctlListDevices) };
    },
  );

  assert.equal(probe.stateReads.length, 1, 'the observed shutdown is still asked about');
  assert.equal(probe.error, CAPTURE_FAILURE, 'a masked capture is never handed to the runner');
});
