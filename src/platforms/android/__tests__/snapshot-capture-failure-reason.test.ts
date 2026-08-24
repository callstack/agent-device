import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { isAndroidCaptureFailureReason } from '@agent-device/contracts/android-snapshot-quality';
import { snapshotAndroid } from '../snapshot.ts';
import { type AndroidAdbExecutor } from '../snapshot-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import {
  isAndroidHelperRuntimeForceStop as isHelperRuntimeReset,
  ANDROID_HELPER_INSTALLED_VERSION_PROBE as installedHelperProbe,
} from './snapshot-helper-session.fixtures.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { isAndroidSnapshotTimeoutError } from '../../../snapshot/snapshot-timeout-policy.ts';

/**
 * The Android capture-failure-reason contract, from producer to consumer.
 *
 * `snapshotAndroid` is the only place that decides an Android capture failed because the
 * accessibility hierarchy never arrived, and it publishes that decision as the typed reason
 * `accessibility-timeout`. These tests assert both halves in one place: that the producer tags
 * exactly the shapes that mean it, and that the daemon's timeout-evidence policy recognizes the
 * value it publishes. Split out of `snapshot.test.ts`, which is over the file-size tripwire.
 */

vi.mock('../../../utils/exec.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/exec.ts')>()),
  runCmd: vi.fn(),
}));

vi.mock('../adb.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adb.ts')>()),
  sleep: vi.fn(async () => {}),
}));

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const helperArtifact = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;

beforeEach(() => {
  resetAndroidSnapshotHelperInstallCache();
  resetAndroidSnapshotHelperSessions();
});

afterEach(() => {
  vi.clearAllMocks();
});

function snapshotAndroidWithHelper(helperAdb: AndroidAdbExecutor) {
  return snapshotAndroid(device, { helperAdb, helperArtifact });
}

function createHelperAdb(
  handlers: Partial<Record<'instrument' | 'activity', AndroidAdbExecutor>>,
): AndroidAdbExecutor {
  return async (args, options) => {
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (isHelperRuntimeReset(args)) return { exitCode: 0, stdout: '', stderr: '' };
    const operation = args.includes('instrument')
      ? 'instrument'
      : args.includes('dumpsys') && args.includes('activity')
        ? 'activity'
        : undefined;
    const handler = operation ? handlers[operation] : undefined;
    if (handler) return await handler(args, options);
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

test('snapshotAndroid preserves structured helper timeout guidance', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 1,
      stdout: [
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: helperApiVersion=1',
        'INSTRUMENTATION_RESULT: ok=false',
        'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
        'INSTRUMENTATION_RESULT: errorType=java.util.concurrent.TimeoutException',
        'INSTRUMENTATION_RESULT: message=Timed out waiting for accessibility root',
        'INSTRUMENTATION_CODE: 1',
      ].join('\n'),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.match((error as Error).message, /Timed out waiting for accessibility root/);
      assert.match((error as Error).message, /Android snapshot helper failed/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(
        details?.hint,
        'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout and report the busy UI if it persists.',
      );
      // The typed reason is what readers key on; the hint above is prose derived from it.
      assert.equal(details?.androidCaptureFailureReason, 'accessibility-timeout');
      assert.equal(isAndroidCaptureFailureReason(details?.androidCaptureFailureReason), true);
      // Producer to consumer: the reason this producer publishes is the one the daemon's
      // timeout-evidence policy recognizes. Asserted against the real policy so the two cannot
      // drift into separate taxonomies.
      assert.equal(isAndroidSnapshotTimeoutError(normalizeError(error)), true);
      return true;
    },
  );
});

test('snapshotAndroid preserves killed helper instrumentation details', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => ({ exitCode: 137, stdout: '', stderr: '' }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      assert.match(
        (error as Error).message,
        /Android snapshot helper failed before returning parseable output/,
      );
      assert.match((error as Error).message, /Android snapshot helper failed/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.exitCode, 137);
      // A helper killed before it could answer is the same claim to a reader as a structured
      // timeout: the hierarchy never arrived. Both shapes publish the one typed reason.
      assert.equal(details?.androidCaptureFailureReason, 'accessibility-timeout');
      assert.equal(isAndroidSnapshotTimeoutError(normalizeError(error)), true);
      return true;
    },
  );
});

test('snapshotAndroid does not claim a timeout for an ordinary helper failure', async () => {
  const helperAdb = createHelperAdb({
    instrument: async () => ({
      exitCode: 1,
      stdout: [
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: helperApiVersion=1',
        'INSTRUMENTATION_RESULT: ok=false',
        'INSTRUMENTATION_RESULT: errorType=java.lang.SecurityException',
        'INSTRUMENTATION_RESULT: message=Permission denied',
        'INSTRUMENTATION_CODE: 1',
      ].join('\n'),
      stderr: '',
    }),
  });

  await assert.rejects(
    () => snapshotAndroidWithHelper(helperAdb),
    (error) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.androidCaptureFailureReason, undefined);
      assert.equal(isAndroidSnapshotTimeoutError(normalizeError(error)), false);
      return true;
    },
  );
});
