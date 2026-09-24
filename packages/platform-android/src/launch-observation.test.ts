import { expect, test, vi } from 'vitest';
import type { Interactor, SnapshotOptions } from '@agent-device/contracts/interactor-types';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  ANDROID_LAUNCH_OBSERVATION_WINDOW_MS,
  createAndroidLaunchObservationProbe,
} from './launch-observation.ts';
import { androidHelperContentUnavailableError } from './snapshot.ts';

type ProbeFixture = Readonly<{
  snapshotOptions: SnapshotOptions[];
  sleeps: number[];
  /** Ends every pending clock sleep, as elapsed time would. */
  elapse: () => void;
  observe: (
    signal?: AbortSignal,
  ) => ReturnType<ReturnType<typeof createAndroidLaunchObservationProbe>['awaitObservable']>;
}>;

function createProbe(snapshot: (options: SnapshotOptions) => Promise<unknown>): ProbeFixture {
  const snapshotOptions: SnapshotOptions[] = [];
  const sleeps: number[] = [];
  const pendingSleeps: Array<() => void> = [];
  const clock = {
    now: () => Date.now(),
    sleep: async (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      await new Promise<void>((resolve, reject) => {
        pendingSleeps.push(resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as PlatformRuntimeHost['clock'];
  const interactor = {
    snapshot: async (options: SnapshotOptions) => {
      snapshotOptions.push(options);
      return await snapshot(options);
    },
  } as unknown as Pick<Interactor, 'snapshot'>;
  const probe = createAndroidLaunchObservationProbe({ clock });
  return {
    snapshotOptions,
    sleeps,
    elapse: () => {
      for (const resolve of pendingSleeps.splice(0)) resolve();
    },
    observe: async (signal = new AbortController().signal) =>
      await probe.awaitObservable(interactor, 'com.example.app', signal),
  };
}

/** What the capture throws once its re-captures still see an unmounted app. */
function contentVerdict(): AppError {
  return androidHelperContentUnavailableError(
    {
      reason: 'content-poor-app-window',
      failureReason: 'Android snapshot helper returned insufficient foreground app content',
      diagnostics: {
        helperNodeCount: 3,
        helperSystemUiNodeCount: 0,
        helperWindowRootCount: 1,
        helperApplicationWindowRootCount: 1,
        helperMeaningfulNodeCount: 0,
        helperApplicationMeaningfulNodeCount: 0,
        helperNonSystemMeaningfulNodeCount: 0,
        helperInputMethodMeaningfulNodeCount: 0,
        helperWindowTypes: [1],
      },
    },
    3,
  );
}

/** A capture that ends only when its signal aborts, as a stuck helper call does. */
async function captureUntilAborted(options: SnapshotOptions): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    if (options.signal?.aborted) reject(options.signal.reason);
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
      once: true,
    });
  });
}

test('a readable launched app is observable through one transient capture', async () => {
  const probe = createProbe(async () => ({ nodes: [] }));

  await expect(probe.observe()).resolves.toEqual({ observation: 'observable' });
  expect(probe.snapshotOptions).toHaveLength(1);
  expect(probe.snapshotOptions[0]).toMatchObject({
    appBundleId: 'com.example.app',
    transient: true,
  });
});

test('a content verdict after the capture re-captures is unobservable', async () => {
  const probe = createProbe(async () => {
    throw contentVerdict();
  });

  await expect(probe.observe()).resolves.toEqual({ observation: 'unobservable' });
});

test('a system surface covering the launched app is unobservable', async () => {
  const probe = createProbe(async () => ({
    nodes: [],
    androidSnapshot: { backend: 'android-helper', systemSurfaceOnly: true },
  }));

  await expect(probe.observe()).resolves.toEqual({ observation: 'unobservable' });
});

test('a capture mechanism failure is a failed probe with its typed reason', async () => {
  const probe = createProbe(async () => {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper failed: accessibility timeout', {
      androidSnapshotHelperFailureReason: 'Android snapshot helper failed: accessibility timeout',
      androidCaptureFailureReason: 'accessibility-timeout',
    });
  });

  await expect(probe.observe()).resolves.toEqual({
    observation: 'probe-failed',
    failure: { code: 'COMMAND_FAILED', reason: 'accessibility-timeout' },
  });
});

test('a helper that is not installed at the current version is a failed probe', async () => {
  const probe = createProbe(async () => {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper is not installed', {
      reason: 'android-snapshot-helper-not-current',
    });
  });

  await expect(probe.observe()).resolves.toEqual({
    observation: 'probe-failed',
    failure: { code: 'COMMAND_FAILED', reason: 'android-snapshot-helper-not-current' },
  });
});

test('a capture that outlasts the fixed window is abandoned as unobservable', async () => {
  const probe = createProbe(captureUntilAborted);

  const observing = probe.observe();
  await vi.waitFor(() => expect(probe.sleeps).toEqual([ANDROID_LAUNCH_OBSERVATION_WINDOW_MS]));
  probe.elapse();

  await expect(observing).resolves.toEqual({ observation: 'unobservable' });
  expect(probe.snapshotOptions[0]?.signal?.aborted).toBe(true);
});

test('a cancelled open rejects with its cancellation, not an observation', async () => {
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const probe = createProbe(async (options) => {
    controller.abort(canceled);
    return await captureUntilAborted(options);
  });

  await expect(probe.observe(controller.signal)).rejects.toBe(canceled);
});
