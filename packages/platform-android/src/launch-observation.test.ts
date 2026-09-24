import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import './__tests__/test-utils/android-host-test-setup.ts';
import type { Interactor, SnapshotOptions } from '@agent-device/contracts/interactor-types';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';
import { ANDROID_LAUNCH_SETTLE_WINDOW_MS, observeAndroidLaunch } from './launch-observation.ts';
import { androidHelperContentUnavailableError } from './snapshot.ts';
import {
  ensureAndroidSnapshotHelper,
  resetAndroidSnapshotHelperInstallCache,
} from './snapshot-helper-install.ts';

type ObserveFixture = Readonly<{
  snapshotOptions: SnapshotOptions[];
  observe: (signal?: AbortSignal) => ReturnType<typeof observeAndroidLaunch>;
}>;

function createObservation(
  snapshot: (options: SnapshotOptions) => Promise<unknown>,
): ObserveFixture {
  const snapshotOptions: SnapshotOptions[] = [];
  const interactor = {
    snapshot: async (options: SnapshotOptions) => {
      snapshotOptions.push(options);
      return await snapshot(options);
    },
  } as unknown as Pick<Interactor, 'snapshot'>;
  return {
    snapshotOptions,
    observe: async (signal = new AbortController().signal) =>
      await observeAndroidLaunch(interactor, 'com.example.app', signal),
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

/** What a transient capture's install step throws on a device without the current helper. */
async function helperNotCurrentError(): Promise<unknown> {
  resetAndroidSnapshotHelperInstallCache();
  const apkPath = path.join(await mkdtempForTest('launch-observation-helper-'), 'helper.apk');
  await fs.writeFile(apkPath, 'helper-apk');
  const sha256 = crypto.createHash('sha256').update('helper-apk').digest('hex');
  try {
    await ensureAndroidSnapshotHelper({
      adb: async () => ({ exitCode: 1, stdout: '', stderr: 'not found' }),
      artifact: {
        apkPath,
        manifest: {
          name: 'android-snapshot-helper',
          version: '0.13.3',
          apkUrl: null,
          sha256,
          packageName: 'com.callstack.agentdevice.snapshothelper',
          versionCode: 13003,
          instrumentationRunner:
            'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
          minSdk: 23,
          targetSdk: 36,
          outputFormat: 'uiautomator-xml',
          statusProtocol: 'android-snapshot-helper-v1',
        },
      },
      deviceKey: 'android:emulator-5554',
      installPolicy: 'current-only',
    });
  } catch (error) {
    return error;
  }
  throw new Error('a current-only check on a device without the helper must reject');
}

test('a readable launched app is observable through one transient capture', async () => {
  const observation = createObservation(async () => ({ nodes: [] }));
  const startedAt = Date.now();

  await expect(observation.observe()).resolves.toEqual({ observation: 'observable' });
  expect(observation.snapshotOptions).toHaveLength(1);
  const settleBy = observation.snapshotOptions[0]?.transient?.settleBy ?? 0;
  expect(settleBy - startedAt).toBeGreaterThanOrEqual(ANDROID_LAUNCH_SETTLE_WINDOW_MS);
  expect(settleBy - Date.now()).toBeLessThanOrEqual(ANDROID_LAUNCH_SETTLE_WINDOW_MS);
});

test('the capture runs under the caller signal alone, so the window never cancels it', async () => {
  const observation = createObservation(async () => ({ nodes: [] }));
  const signal = new AbortController().signal;

  await observation.observe(signal);

  expect(observation.snapshotOptions[0]?.signal).toBe(signal);
});

test('a content verdict after the capture re-captures is unobservable', async () => {
  const observation = createObservation(async () => {
    throw contentVerdict();
  });

  await expect(observation.observe()).resolves.toEqual({ observation: 'unobservable' });
});

test('a system surface covering the launched app is unobservable', async () => {
  const observation = createObservation(async () => ({
    nodes: [],
    androidSnapshot: { backend: 'android-helper', systemSurfaceOnly: true },
  }));

  await expect(observation.observe()).resolves.toEqual({ observation: 'unobservable' });
});

test('a capture mechanism failure is a failed probe with its typed reason', async () => {
  const observation = createObservation(async () => {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper failed: accessibility timeout', {
      androidSnapshotHelperFailureReason: 'Android snapshot helper failed: accessibility timeout',
      androidCaptureFailureReason: 'accessibility-timeout',
    });
  });

  await expect(observation.observe()).resolves.toEqual({
    observation: 'probe-failed',
    failure: { code: 'COMMAND_FAILED', reason: 'accessibility-timeout' },
  });
});

test('a device without the current helper is a failed probe', async () => {
  const notCurrent = await helperNotCurrentError();
  const observation = createObservation(async () => {
    throw notCurrent;
  });

  await expect(observation.observe()).resolves.toEqual({
    observation: 'probe-failed',
    failure: { code: 'COMMAND_FAILED', reason: 'android-snapshot-helper-not-current' },
  });
});

test('a cancelled open rejects with its cancellation, not an observation', async () => {
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const observation = createObservation(async () => {
    controller.abort(canceled);
    throw canceled;
  });

  await expect(observation.observe(controller.signal)).rejects.toBe(canceled);
});
