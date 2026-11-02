import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { AndroidAdbExecutorResult, AndroidAdbProvider } from '../adb-executor.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  ANDROID_HELPER_INSTALLED_VERSION_PROBE,
  androidHelperInstrumentationOutput,
  androidHelperRuntimeProbeResult,
  FakeAndroidProcess,
  isAndroidHelperRuntimeForceStop,
  isAndroidHelperRuntimeProbe,
} from './snapshot-helper-session.fixtures.ts';
import { bindAndroidAdbTestHost } from './test-utils/android-host-test-setup.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const HELPER_RUNNER = `${ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.packageName}/.SnapshotInstrumentation`;

// What `am instrument` prints when the system could not start the instrumentation at all.
const INSTRUMENTATION_FAILED_RUN: AndroidAdbExecutorResult = {
  exitCode: 1,
  stdout: '',
  stderr: `android.util.AndroidException: INSTRUMENTATION_FAILED: ${HELPER_RUNNER}\n`,
};

const CAPTURED_RUN: AndroidAdbExecutorResult = {
  exitCode: 0,
  stdout: androidHelperInstrumentationOutput(
    '<hierarchy><node text="after retry" bounds="[0,0][10,10]" /></hierarchy>',
  ),
  stderr: '',
};

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
  resetAndroidSnapshotHelperInstallCache();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

/**
 * A device right after boot (#4109): the helper is installed and current, the persistent session
 * exits before it is ready, and each one-shot run answers with the next of `oneShotRuns`.
 */
function freshlyBootedHelper(oneShotRuns: AndroidAdbExecutorResult[]): {
  provider: AndroidAdbProvider;
  calls: (readonly string[])[];
} {
  bindAndroidAdbTestHost();
  const calls: (readonly string[])[] = [];
  const runs = [...oneShotRuns];
  return {
    calls,
    provider: {
      exec: async (args) => {
        calls.push(args);
        if (args.includes('--show-versioncode')) return ANDROID_HELPER_INSTALLED_VERSION_PROBE;
        if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult();
        if (args.includes('instrument')) return runs.shift() ?? CAPTURED_RUN;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      spawn: () => {
        const process = new FakeAndroidProcess();
        setImmediate(() => {
          process.stderr.write(INSTRUMENTATION_FAILED_RUN.stderr);
          process.emitExit(1, null);
        });
        return process;
      },
    },
  };
}

const isOneShotRun = (args: readonly string[]) => args.includes('instrument');

async function snapshotRejection(provider: AndroidAdbProvider) {
  try {
    await snapshotAndroid(device, {
      helperAdb: provider,
      helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    });
  } catch (error) {
    return normalizeError(error);
  }
  assert.fail('expected the snapshot to fail');
}

test('a helper the system failed to start gets one more start after a runtime reset', async () => {
  const { provider, calls } = freshlyBootedHelper([INSTRUMENTATION_FAILED_RUN]);

  const snapshot = await snapshotAndroid(device, {
    helperAdb: provider,
    helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  });

  assert.ok(snapshot.nodes.some((node) => node.label === 'after retry'));
  const oneShotRuns = calls.flatMap((args, index) => (isOneShotRun(args) ? [index] : []));
  assert.equal(oneShotRuns.length, 2);
  assert.ok(
    calls.slice(oneShotRuns[0], oneShotRuns[1]).some(isAndroidHelperRuntimeForceStop),
    'the helper runtime is reset before the second start',
  );
});

test('a helper the system fails to start twice reports the start failure', async () => {
  const { provider, calls } = freshlyBootedHelper([
    INSTRUMENTATION_FAILED_RUN,
    INSTRUMENTATION_FAILED_RUN,
  ]);

  const error = await snapshotRejection(provider);

  assert.equal(calls.filter(isOneShotRun).length, 2);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.deepEqual(error.details?.instrumentation, { exitCode: 1, failed: HELPER_RUNNER });
});

test('a helper that started and then exited early is not started again', async () => {
  const earlyExits: AndroidAdbExecutorResult[] = [
    { exitCode: 1, stdout: 'INSTRUMENTATION_ABORTED: System has crashed.\n', stderr: '' },
    // The same words without the startup-failure envelope are a message, not a failed start.
    {
      exitCode: 1,
      stdout: `INSTRUMENTATION_RESULT: shortMsg=INSTRUMENTATION_FAILED: ${HELPER_RUNNER}\n`,
      stderr: '',
    },
  ];
  for (const run of earlyExits) {
    await resetAndroidSnapshotHelperSessions();
    resetAndroidSnapshotHelperInstallCache();
    const { provider, calls } = freshlyBootedHelper([run]);

    const error = await snapshotRejection(provider);

    assert.equal(calls.filter(isOneShotRun).length, 1, run.stdout);
    assert.equal(error.code, 'COMMAND_FAILED');
  }
});
