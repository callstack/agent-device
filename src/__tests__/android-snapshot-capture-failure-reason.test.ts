import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { isAndroidCaptureFailureReason } from '@agent-device/contracts/android-snapshot-quality';
import {
  snapshotAndroid,
  type AndroidAdbExecutor,
  type AndroidAdbExecutorResult,
  resetAndroidSnapshotHelperInstallCache,
  resetAndroidSnapshotHelperSessions,
} from '@agent-device/platform-android/mechanics';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import { isAndroidSnapshotTimeoutError } from '../snapshot/snapshot-timeout-policy.ts';
import '../platform-runtime-android-adb-host.ts';

/**
 * The Android capture-failure-reason contract, from producer to consumer.
 *
 * `snapshotAndroid` is the only place that decides an Android capture failed because the
 * accessibility hierarchy never arrived, and it publishes that decision as the typed reason
 * `accessibility-timeout`. These tests assert both halves in one place: that the producer tags
 * exactly the shapes that mean it, and that the daemon's timeout-evidence policy recognizes the
 * value it publishes. Split out of `snapshot.test.ts`, which is over the file-size tripwire.
 */

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
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
    const version = helperVersionResponse(args);
    if (version) return version;
    if (isHelperForceStop(args)) return { exitCode: 0, stdout: '', stderr: '' };
    const operation = helperOperation(args);
    const handler = operation ? handlers[operation] : undefined;
    if (handler) return await handler(args, options);
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

function helperVersionResponse(args: readonly string[]): AndroidAdbExecutorResult | undefined {
  if (!args.includes('--show-versioncode')) return undefined;
  return {
    exitCode: 0,
    stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:999999',
    stderr: '',
  };
}

function isHelperForceStop(args: readonly string[]): boolean {
  return args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop';
}

function helperOperation(args: readonly string[]): 'instrument' | 'activity' | undefined {
  if (args.includes('instrument')) return 'instrument';
  if (args.includes('dumpsys') && args.includes('activity')) return 'activity';
  return undefined;
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

function helperFailure(errorType: string, message: string): AndroidAdbExecutor {
  return createHelperAdb({
    instrument: async () => ({
      exitCode: 1,
      stdout: [
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: helperApiVersion=1',
        'INSTRUMENTATION_RESULT: ok=false',
        `INSTRUMENTATION_RESULT: errorType=${errorType}`,
        `INSTRUMENTATION_RESULT: message=${message}`,
        'INSTRUMENTATION_CODE: 1',
      ].join('\n'),
      stderr: '',
    }),
  });
}

async function classifiedReason(helperAdb: AndroidAdbExecutor): Promise<{
  reason: unknown;
  recognized: boolean;
}> {
  try {
    await snapshotAndroidWithHelper(helperAdb);
  } catch (error) {
    return {
      reason: (error as { details?: Record<string, unknown> }).details?.androidCaptureFailureReason,
      recognized: isAndroidSnapshotTimeoutError(normalizeError(error)),
    };
  }
  throw new Error('expected the helper capture to reject');
}

/**
 * The classification is a value, not a message shape. These two are the whole claim: prose can be
 * rewritten in any way without moving the typed reason, and prose that reads exactly like a
 * timeout does not produce one when the machine-defined `errorType` says otherwise.
 */
test('rewording the helper message preserves the typed timeout reason', async () => {
  for (const message of [
    'Timed out waiting for accessibility root',
    'the accessibility hierarchy never arrived',
    '',
    'ROOT_WAIT_EXCEEDED (code 4)',
  ]) {
    const outcome = await classifiedReason(
      helperFailure('java.util.concurrent.TimeoutException', message),
    );
    assert.equal(outcome.reason, 'accessibility-timeout', message);
    assert.equal(outcome.recognized, true, message);
  }
});

test('timeout-looking prose without the machine-defined type is not classified', async () => {
  for (const [errorType, message] of [
    ['java.lang.IllegalStateException', 'the request timed out waiting for the window'],
    ['java.lang.SecurityException', 'Timed out: permission denied'],
    ['android.os.DeadObjectException', 'TimeoutException-like failure'],
  ]) {
    const outcome = await classifiedReason(helperFailure(errorType!, message!));
    assert.equal(outcome.reason, undefined, errorType);
    assert.equal(outcome.recognized, false, errorType);
  }
});

test('snapshotAndroid does not claim a timeout for an ordinary helper failure', async () => {
  const outcome = await classifiedReason(
    helperFailure('java.lang.SecurityException', 'Permission denied'),
  );
  assert.equal(outcome.reason, undefined);
  assert.equal(outcome.recognized, false);
});
