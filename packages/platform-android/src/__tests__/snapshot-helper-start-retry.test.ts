import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';

// Time does not pass on its own: a wait without a signal ends at once, and a cancellable wait ends
// only when its signal aborts, so a wait that ignores the caller's cancellation is observable.
vi.mock('../adb.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adb.ts')>();
  return {
    ...actual,
    sleep: vi.fn(
      async (_ms: number, signal?: AbortSignal) =>
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    ),
  };
});

import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { AndroidAdbExecutorResult, AndroidAdbProvider } from '../adb-executor.ts';
import { isRefusedInstrumentationStart } from '../instrumentation-helper.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { resetAndroidSnapshotHelperInstallCache } from '../snapshot-helper-install.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import {
  ANDROID_HELPER_INSTALLED_VERSION_PROBE,
  createSessionProvider,
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

// What `am instrument -w` prints when the system refuses to start the instrumentation, as captured
// from an Android 15 emulator: ActivityManagerService reports the refusal as status -1, and then
// `am` throws INSTRUMENTATION_FAILED.
const REFUSED_STDOUT = [
  `INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{${HELPER_RUNNER}}`,
  'INSTRUMENTATION_STATUS: id=ActivityManagerService',
  'INSTRUMENTATION_STATUS_CODE: -1',
  '',
].join('\n');
const REFUSED_STDERR = [
  `android.util.AndroidException: INSTRUMENTATION_FAILED: ${HELPER_RUNNER}`,
  '\tat com.android.commands.am.Instrument.run(Instrument.java:543)',
  '\tat com.android.commands.am.Am.runInstrument(Am.java:213)',
  '',
].join('\n');
const INSTRUMENTATION_FAILED_RUN: AndroidAdbExecutorResult = {
  exitCode: 1,
  stdout: REFUSED_STDOUT,
  stderr: REFUSED_STDERR,
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

type OneShotRun = AndroidAdbExecutorResult | AppError;

/**
 * A device whose helper is installed and current. Its persistent session either exits before it is
 * ready, refused like the one-shot run (#4109), or becomes ready and then fails its capture. Each
 * one-shot run answers with the next of `oneShotRuns`; an `AppError` is thrown as the executor does.
 */
function freshlyBootedHelper(
  oneShotRuns: OneShotRun[],
  session: 'exits-before-ready' | 'ready-then-fails' = 'exits-before-ready',
): { provider: AndroidAdbProvider; calls: (readonly string[])[] } {
  bindAndroidAdbTestHost();
  const calls: (readonly string[])[] = [];
  const runs = [...oneShotRuns];
  const failingSession = createSessionProvider({ calls: [], responseMode: 'malformed' });
  return {
    calls,
    provider: {
      exec: async (args) => {
        calls.push(args);
        if (args.includes('--show-versioncode')) return ANDROID_HELPER_INSTALLED_VERSION_PROBE;
        if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult();
        if (!isOneShotRun(args)) return { exitCode: 0, stdout: '', stderr: '' };
        const run = runs.shift() ?? CAPTURED_RUN;
        if (run instanceof AppError) throw run;
        return run;
      },
      spawn: (args, options) => {
        if (session === 'ready-then-fails') return failingSession.spawn!(args, options);
        const process = new FakeAndroidProcess();
        setImmediate(() => {
          process.stdout.write(REFUSED_STDOUT);
          process.stderr.write(REFUSED_STDERR);
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

// One row per condition of a refused start: each row is the captured refusal with exactly that
// condition broken, so dropping the condition from the predicate flips its rows and no others.
const refusal = { exitCode: 1, stdout: REFUSED_STDOUT, stderr: REFUSED_STDERR };
const refusalRows: {
  breaks: string;
  run: { exitCode: number | null; stdout: string; stderr: string; signal?: string };
}[] = [
  { breaks: 'nothing', run: refusal },
  {
    breaks: 'the INSTRUMENTATION_FAILED envelope',
    run: { ...refusal, stderr: REFUSED_STDERR.split('\n').slice(1).join('\n') },
  },
  { breaks: 'an exit status', run: { ...refusal, exitCode: null } },
  { breaks: 'a non-zero exit', run: { ...refusal, exitCode: 0 } },
  { breaks: 'no signal', run: { ...refusal, signal: 'SIGKILL' } },
  {
    breaks: 'the system reporter',
    run: { ...refusal, stdout: REFUSED_STDOUT.replace('id=ActivityManagerService', 'id=Other') },
  },
  {
    breaks: 'the refusal status code',
    run: {
      ...refusal,
      stdout: REFUSED_STDOUT.replace('STATUS_CODE: -1', 'STATUS_CODE: -2'),
    },
  },
  ...[
    [
      'a trailing helper status',
      'INSTRUMENTATION_STATUS: agentDeviceProtocol=1\nINSTRUMENTATION_STATUS: payloadBase64=PHg+\n',
    ],
    ['a malformed trailing result', 'INSTRUMENTATION_RESULT: invalid\n'],
    ['a trailing result message', 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.\n'],
    ['a trailing abort', 'INSTRUMENTATION_ABORTED: System has crashed.\n'],
    ['a trailing withheld abort', 'INSTRUMENTATION_ABORTED: <node text="private" />\n'],
    ['a trailing plain line', 'plain output\n'],
  ].map(([what, trailer]) => ({
    breaks: `the refusal-only stdout (${what})`,
    run: { ...refusal, stdout: `${REFUSED_STDOUT}${trailer}` },
  })),
  {
    breaks: 'the refusal-only stdout (an earlier helper status)',
    run: {
      ...refusal,
      stdout: `INSTRUMENTATION_STATUS: numtests=1\nINSTRUMENTATION_STATUS_CODE: 1\n${REFUSED_STDOUT}`,
    },
  },
  {
    breaks: 'the refusal-only stdout (no Error record)',
    run: { ...refusal, stdout: REFUSED_STDOUT.split('\n').slice(1).join('\n') },
  },
];

test('a refused start is told apart from every run that breaks one of its conditions', () => {
  const misclassified = refusalRows
    .filter((row) => isRefusedInstrumentationStart(row.run) !== (row.breaks === 'nothing'))
    .map((row) => row.breaks);
  assert.deepEqual(misclassified, []);
});

// The two conditions that live outside the run's parsed result: the run came back from adb on its
// own, and no session was ready for the capture.
const captureRows: {
  name: string;
  run: OneShotRun;
  session?: 'ready-then-fails';
  retried: boolean;
}[] = [
  { name: 'a start the system refused', run: INSTRUMENTATION_FAILED_RUN, retried: true },
  {
    name: 'a refused start after a session was ready',
    run: INSTRUMENTATION_FAILED_RUN,
    session: 'ready-then-fails',
    retried: false,
  },
  {
    name: 'a run the command budget ended',
    run: new AppError('COMMAND_FAILED', 'adb command timed out', {
      timeoutMs: 30_000,
      exitCode: 1,
      stdout: REFUSED_STDOUT,
      stderr: REFUSED_STDERR,
    }),
    retried: false,
  },
];

for (const row of captureRows) {
  test(`${row.name} ${row.retried ? 'gets one more start after a runtime reset' : 'is not started again'}`, async () => {
    const { provider, calls } = freshlyBootedHelper([row.run], row.session);

    if (!row.retried) {
      const error = await snapshotRejection(provider);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(calls.filter(isOneShotRun).length, 1);
      return;
    }
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
}

test('a helper the system refuses to start twice reports the refusal', async () => {
  const { provider, calls } = freshlyBootedHelper([
    INSTRUMENTATION_FAILED_RUN,
    INSTRUMENTATION_FAILED_RUN,
  ]);

  const error = await snapshotRejection(provider);

  assert.equal(calls.filter(isOneShotRun).length, 2);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.androidSnapshotHelperStartRefused, true);
  assert.deepEqual(error.details?.instrumentation, {
    exitCode: 1,
    statusCode: -1,
    failed: HELPER_RUNNER,
    error: `Unable to find instrumentation info for: ComponentInfo{${HELPER_RUNNER}}`,
  });
});

// The reset before the second start is a force-stop and then a settle delay; a cancellation in either
// ends the capture there.
for (const cancelPoint of ['force-stop', 'settle delay'] as const) {
  test(`a capture cancelled during the reset's ${cancelPoint} rejects without starting the helper again`, async () => {
    const { provider, calls } = freshlyBootedHelper([INSTRUMENTATION_FAILED_RUN]);
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('wait deadline exceeded'));
    const exec = provider.exec;
    provider.exec = async (args, options) => {
      // The reset that follows the refused one-shot start, not the session's own cleanup.
      if (!isAndroidHelperRuntimeForceStop(args) || !calls.some(isOneShotRun)) {
        return await exec(args, options);
      }
      calls.push(args);
      if (cancelPoint === 'settle delay') {
        setImmediate(cancel);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      // A force-stop that hangs ends only through the signal it was given; the cancellation lands
      // once it is in flight and listening.
      return await new Promise((_resolve, reject) => {
        const signal = options?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        setImmediate(cancel);
      });
    };

    await assert.rejects(
      snapshotAndroid(device, {
        helperAdb: provider,
        helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
        signal: controller.signal,
      }),
      /wait deadline exceeded/,
    );
    assert.equal(calls.filter(isOneShotRun).length, 1);
  });
}
