import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { captureAndroidSnapshotWithHelper } from '../snapshot-helper-capture.ts';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { resetAndroidSnapshotHelperRetirements } from '../snapshot-helper-retirement.ts';
import { snapshotAndroid } from '../snapshot.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AndroidAdbExecutor } from '../snapshot-helper-types.ts';
import type { AndroidAdbProvider } from '../adb-executor.ts';
import {
  androidHelperRuntimeProbeResult,
  createSessionProvider,
  FakeAndroidProcess,
  isAndroidHelperRuntimeForceStop,
  isAndroidHelperRuntimeProbe,
} from './snapshot-helper-session.fixtures.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';

beforeEach(async () => {
  resetAndroidSnapshotHelperRetirements();
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

// Instrumentation outputs as `am instrument -w` prints them when the helper never reports.
const ABORTED_RUN = [
  'INSTRUMENTATION_STATUS: numtests=1',
  'INSTRUMENTATION_STATUS_CODE: 1',
  'INSTRUMENTATION_ABORTED: System has crashed.',
  '',
].join('\n');

const CRASHED_RUN = [
  'INSTRUMENTATION_RESULT: shortMsg=java.lang.IllegalStateException',
  'INSTRUMENTATION_RESULT: longMsg=java.lang.IllegalStateException: UiAutomation not connected',
  'INSTRUMENTATION_CODE: 0',
  '',
].join('\n');

type FailedRun = { exitCode: number; stdout: string; stderr?: string; signal?: string };

type ExitResultFields = {
  exitCode: number | null;
  signal?: string;
  resultCode?: number;
  statusCode?: number;
  aborted?: string;
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  error?: string;
  stack?: string;
  stderrTail: string;
  stderrTruncated: boolean;
  snapshotContentRemoved?: true;
};

const SECRET = 'hunter2-account-number';
const SECRET_XML = `<hierarchy rotation="0"><node text="${SECRET}" bounds="[0,0][10,10]" /></hierarchy>`;
const SECRET_BASE64 = Buffer.from(SECRET_XML).toString('base64');

const emulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

async function captureError(run: FailedRun): Promise<AppError> {
  try {
    await captureAndroidSnapshotWithHelper({ adb: async () => ({ stderr: '', ...run }) });
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the capture to fail');
}

async function captureExitResult(run: FailedRun): Promise<ExitResultFields> {
  return (await captureError(run)).details?.instrumentation as ExitResultFields;
}

function encodedPayload(xml: string): string {
  return `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml).toString('base64')}`;
}

function helperFailingWith(run: FailedRun): AndroidAdbExecutor {
  return async (args) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
        stderr: '',
      };
    }
    if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult();
    if (isAndroidHelperRuntimeForceStop(args)) return { exitCode: 0, stdout: '', stderr: '' };
    return { stderr: '', ...run };
  };
}

async function withLog<T>(
  run: (logPath: string) => Promise<T>,
): Promise<{ result: T; log: string }> {
  const tmpDir = await mkdtempForTest('agent-device-android-exit-result-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const result = await run(logPath);
    return { result, log: await fs.readFile(logPath, 'utf8') };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function inScope<T>(logPath: string, body: () => Promise<T>): Promise<T> {
  return withDiagnosticsScope(
    { debug: true, logPath, session: 'android-test', requestId: 'req-1', command: 'snapshot' },
    body,
  );
}

function diagnosticData(log: string, phase: string): Record<string, unknown> {
  const event = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; data?: Record<string, unknown> })
    .find((entry) => entry.phase === phase);
  assert.ok(event, `expected a ${phase} diagnostic`);
  return event.data ?? {};
}

function exitResultOf(fields: Record<string, unknown>): ExitResultFields {
  return fields.instrumentation as ExitResultFields;
}

/** Runs a ready session whose helper process prints through `print` and then exits with 1. */
async function sessionExit(
  print: (process: FakeAndroidProcess) => Promise<void>,
): Promise<{ exit: ExitResultFields; log: string }> {
  const { result, log } = await withLog(async (logPath) => {
    const processes: FakeAndroidProcess[] = [];
    const provider = createSessionProvider({ calls: [], processes });
    const capture = () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
    await inScope(logPath, async () => {
      assert.ok(await capture());
      await print(processes[0]!);
      await pause();
      processes[0]!.emitExit(1, null);
      await capture();
    });
    return undefined;
  });
  void result;
  return {
    exit: exitResultOf(diagnosticData(log, 'android_snapshot_helper_session_exited')),
    log,
  };
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function assertPrivate(text: string): void {
  assert.ok(!text.includes(SECRET), text.slice(-800));
  assert.ok(!text.includes(SECRET_BASE64.slice(0, 24)), text.slice(-800));
}

test('an aborted instrumentation run reports the abort, the status code and the exit status', async () => {
  assert.deepEqual(await captureExitResult({ exitCode: 1, stdout: ABORTED_RUN }), {
    exitCode: 1,
    statusCode: 1,
    aborted: 'System has crashed.',
    stderrTail: '',
    stderrTruncated: false,
  });
});

test('a crashed instrumentation run reports shortMsg, longMsg and the result code', async () => {
  assert.deepEqual(await captureExitResult({ exitCode: 0, stdout: CRASHED_RUN }), {
    exitCode: 0,
    resultCode: 0,
    shortMsg: 'java.lang.IllegalStateException',
    longMsg: 'java.lang.IllegalStateException: UiAutomation not connected',
    stderrTail: '',
    stderrTruncated: false,
  });
});

test('the host signal that ended the run reaches the details', async () => {
  assert.equal(
    (await captureExitResult({ exitCode: 1, stdout: '', signal: 'SIGKILL' })).signal,
    'SIGKILL',
  );
});

test('an empty or out-of-range INSTRUMENTATION_CODE is not recorded as a result code', async () => {
  const empty = await captureExitResult({
    exitCode: 1,
    stdout: 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: \n',
  });
  assert.equal(empty.resultCode, undefined);
  assert.equal(empty.shortMsg, 'Process crashed.');

  const huge = await captureExitResult({
    exitCode: 1,
    stdout: `INSTRUMENTATION_CODE: ${'9'.repeat(400)}\n`,
  });
  assert.equal(huge.resultCode, undefined);
});

test('multiline protocol values keep their continuation lines until the next record', async () => {
  const crlf = await captureExitResult({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_RESULT: shortMsg=Process crashed.',
      'INSTRUMENTATION_RESULT: longMsg=UiAutomation failed',
      'Caused by: binder has died',
      'INSTRUMENTATION_CODE: 0',
      '',
    ].join('\r\n'),
  });
  assert.equal(crlf.shortMsg, 'Process crashed.');
  assert.equal(crlf.longMsg, 'UiAutomation failed\nCaused by: binder has died');
  assert.equal(crlf.resultCode, 0);

  const stack = await captureExitResult({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_STATUS: Error=java.lang.IllegalStateException: no root',
      'INSTRUMENTATION_STATUS: stack=java.lang.IllegalStateException: no root',
      '\tat android.app.UiAutomation.connect(UiAutomation.java:12)',
      '\tat com.callstack.agentdevice.snapshothelper.Main.<init>(Main.java:7)',
      'INSTRUMENTATION_STATUS_CODE: -2',
    ].join('\n'),
  });
  assert.equal(stack.error, 'java.lang.IllegalStateException: no root');
  assert.equal(
    stack.stack,
    [
      'java.lang.IllegalStateException: no root',
      '\tat android.app.UiAutomation.connect(UiAutomation.java:12)',
      '\tat com.callstack.agentdevice.snapshothelper.Main.<init>(Main.java:7)',
    ].join('\n'),
  );
  assert.equal(stack.statusCode, -2);

  const interleaved = await captureExitResult({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_RESULT: longMsg=first line',
      'second line',
      encodedPayload(SECRET_XML),
      'not part of the message',
    ].join('\n'),
  });
  assert.equal(interleaved.longMsg, 'first line\nsecond line');
});

test('single-line and multiline messages are held to the message cap', async () => {
  const result = await captureExitResult({
    exitCode: 0,
    stdout: `INSTRUMENTATION_RESULT: shortMsg=${'s'.repeat(10_000)}\nINSTRUMENTATION_RESULT: longMsg=${'l'.repeat(2_000)}\n${'m'.repeat(2_000)}\nINSTRUMENTATION_CODE: 0`,
  });

  assert.equal(result.shortMsg?.length, 2_048);
  assert.ok((result.longMsg?.length ?? 0) <= 2_048);
});

test('startup failures are recognized in every envelope AOSP prints', async () => {
  const forms = [
    ['INSTRUMENTATION_FAILED: com.example/.Missing', 'com.example/.Missing'],
    [
      'android.util.AndroidException: INSTRUMENTATION_FAILED: com.example/.Missing',
      'com.example/.Missing',
    ],
    [
      'onError: commandError=true message=INSTRUMENTATION_FAILED: com.example/.Missing',
      'com.example/.Missing',
    ],
    ['INSTRUMENTATION_FAILED:', ''],
  ] as const;
  for (const [line, expected] of forms) {
    for (const stream of ['stdout', 'stderr'] as const) {
      const run =
        stream === 'stdout' ? { stdout: `${line}\n` } : { stdout: '', stderr: `${line}\n` };
      const result = await captureExitResult({ exitCode: 1, ...run });
      assert.equal(result.failed, expected, `${stream}: ${line}`);
    }
  }
});

test('stdout is never copied: only parsed protocol fields reach the details', async () => {
  const error = await captureError({
    exitCode: 1,
    stdout: `${CRASHED_RUN}some unrelated stdout line\n`,
  });

  assert.equal('stdout' in (error.details ?? {}), false);
  assert.ok(!JSON.stringify(error.details).includes('some unrelated stdout line'));
});

test('a sensitive value never reaches the details wherever the helper printed it', async () => {
  const runs: FailedRun[] = [
    // A complete encoded payload.
    { exitCode: 1, stdout: `${encodedPayload(SECRET_XML)}\nINSTRUMENTATION_STATUS_CODE: 1` },
    // An unknown status key carrying raw XML.
    { exitCode: 1, stdout: `INSTRUMENTATION_STATUS: stream=${SECRET_XML}\n` },
    // A protocol record holding an attribute with no opening tag.
    {
      exitCode: 1,
      stdout: `INSTRUMENTATION_STATUS: detail=ret" text="${SECRET}" bounds="[0,0][1,1]" />\n`,
    },
    // A tagless fragment as a free line, and as a message continuation.
    { exitCode: 1, stdout: `ret" text="${SECRET}" bounds="[0,0][1,1]" />\n` },
    {
      exitCode: 1,
      stdout: `INSTRUMENTATION_RESULT: longMsg=boom\nret" text="${SECRET}" bounds="[0,0][1,1]" />\n`,
    },
    {
      exitCode: 1,
      stdout: `INSTRUMENTATION_RESULT: shortMsg=ret" content-desc="${SECRET}" bounds="[0,0][1,1]" />\n`,
    },
    // A fragment on stderr, raw and as a one-line report with a late secret.
    { exitCode: 1, stdout: '', stderr: `ret" text="${SECRET}" bounds="[0,0][1,1]" />` },
    { exitCode: 1, stdout: '', stderr: `${'a'.repeat(30_000)}${SECRET_XML}` },
  ];
  for (const run of runs) {
    const error = await captureError({ ...run, stderr: `${run.stderr ?? ''}\nam: Killed` });
    const wire = JSON.stringify(normalizeError(error));
    assertPrivate(wire);
    assert.ok(wire.includes('am: Killed'), wire.slice(-400));
    assert.equal(exitResultOf(normalizeError(error).details ?? {}).snapshotContentRemoved, true);

    const { log } = await withLog(async (logPath) => {
      await inScope(logPath, async () => {
        await assert.rejects(
          snapshotAndroid(emulator, {
            helperAdb: helperFailingWith({ ...run, stderr: `${run.stderr ?? ''}\nam: Killed` }),
            helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
          }),
        );
      });
    });
    assert.ok(log.includes('android_snapshot_helper_failed'));
    assertPrivate(log);
  }
});

test('a session exit never leaks a sensitive value split across chunks', async () => {
  const { exit, log } = await sessionExit(async (process) => {
    // The payload and the sensitive key arrive in pieces, with stderr interleaved.
    process.stdout.write(`INSTRUMENTATION_STATUS: payloadBase64=${SECRET_BASE64.slice(0, 20)}`);
    process.stderr.write('pass');
    await pause();
    process.stdout.write(`${SECRET_BASE64.slice(20)}\nINSTRUMENTATION_STATUS_CODE: 1\n`);
    process.stderr.write(`word=${SECRET}\n`);
    process.stderr.write(`ret" text="${SECRET}"`);
    process.stderr.write(' bounds="[0,0][1,1]" />\nam: Killed\n');
    process.stdout.write('INSTRUMENTATION_ABORTED: System has crashed.\n');
  });

  assertPrivate(log);
  assert.equal(exit.aborted, 'System has crashed.');
  assert.equal(exit.snapshotContentRemoved, true);
  assert.ok(exit.stderrTail.endsWith('am: Killed'), exit.stderrTail);
});

test('stderr chunks do not disturb a partial stdout record', async () => {
  const { exit } = await sessionExit(async (process) => {
    process.stdout.write('INSTRUMENTATION_RESULT: longMsg=UiAutomation fai');
    process.stderr.write('am: warning\n');
    await pause();
    process.stdout.write('led\nCaused by: binder has died\nINSTRUMENTATION_CODE: 0\n');
  });

  assert.equal(exit.longMsg, 'UiAutomation failed\nCaused by: binder has died');
  assert.equal(exit.resultCode, 0);
  assert.equal(exit.stderrTail, 'am: warning');
});

test('ordinary quoted assignments on stderr are kept while snapshot attributes are dropped', async () => {
  const result = await captureExitResult({
    exitCode: 1,
    stdout: '',
    stderr: [
      'E AndroidRuntime: java.lang.IllegalStateException message="binder died" code="7"',
      `ret" text="${SECRET}" bounds="[0,0][1,1]" />`,
    ].join('\n'),
  });

  assert.ok(result.stderrTail.includes('message="binder died" code="7"'), result.stderrTail);
  assert.ok(!result.stderrTail.includes(SECRET));
  assert.equal(result.snapshotContentRemoved, true);
  assert.equal(result.stderrTruncated, true);
});

test('the real cause past the redaction cap survives in the error and the request log', async () => {
  const filler = Array.from({ length: 40 }, (_, index) => `line ${index} of helper output`).join(
    '\n',
  );
  const stderr = `${filler}\nam: Killed by the low memory killer`;
  const error = await captureError({ exitCode: 1, stdout: '', stderr });

  const wire = exitResultOf(normalizeError(error).details ?? {});
  assert.ok(wire.stderrTail.endsWith('am: Killed by the low memory killer'), wire.stderrTail);
  assert.ok(wire.stderrTail.length <= 400);
  assert.equal(wire.stderrTruncated, true);

  const short = await captureError({ exitCode: 1, stdout: '', stderr: `${'y'.repeat(500)} done` });
  const shortWire = exitResultOf(normalizeError(short).details ?? {});
  assert.equal(shortWire.stderrTruncated, true);
  assert.ok(shortWire.stderrTail.endsWith('done'));

  const { log } = await withLog(async (logPath) => {
    await inScope(logPath, async () => {
      await assert.rejects(
        snapshotAndroid(emulator, {
          helperAdb: helperFailingWith({ exitCode: 1, stdout: '', stderr }),
          helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
        }),
      );
    });
  });
  const logged = exitResultOf(diagnosticData(log, 'android_snapshot_helper_failed'));
  assert.ok(logged.stderrTail.endsWith('am: Killed by the low memory killer'), logged.stderrTail);
  assert.equal(logged.stderrTruncated, true);
});

test('stderr beyond the retained window keeps the newest lines', async () => {
  const lines = Array.from({ length: 100 }, (_, index) => `${index} ${'w'.repeat(400)}`);
  const result = await captureExitResult({
    exitCode: 1,
    stdout: '',
    stderr: `${lines.join('\n')}\nam: Killed`,
  });

  assert.ok(result.stderrTail.endsWith('am: Killed'));
  assert.equal(result.stderrTruncated, true);
});

test('a long stderr diagnostic line keeps its end and a long snapshot line is dropped', async () => {
  const diagnostic = `${'frame '.repeat(5_000)}Caused by: binder has died`;
  const kept = await captureExitResult({ exitCode: 1, stdout: '', stderr: diagnostic });
  assert.ok(kept.stderrTail.endsWith('Caused by: binder has died'), kept.stderrTail);
  assert.equal(kept.stderrTruncated, true);
  assert.equal(kept.snapshotContentRemoved, undefined);

  const snapshot = `<hierarchy>${`<node text="${SECRET}" />`.repeat(2_000)}</hierarchy>`;
  const dropped = await captureExitResult({
    exitCode: 1,
    stdout: '',
    stderr: `${snapshot}\nam: Killed`,
  });
  assert.ok(!dropped.stderrTail.includes(SECRET));
  assert.ok(dropped.stderrTail.endsWith('am: Killed'));
  assert.equal(dropped.snapshotContentRemoved, true);
  assert.equal(dropped.stderrTruncated, true);
});

test('a session exit keeps a long diagnostic line and flags a chunked snapshot line it dropped', async () => {
  const { exit, log } = await sessionExit(async (process) => {
    // Lines arrive in pieces and outgrow the window before they complete.
    process.stderr.write('frame '.repeat(4_000));
    await pause();
    process.stderr.write(`${'frame '.repeat(1_000)}Caused by: binder has died\n`);
    process.stderr.write(`<hierarchy><node text="${SECRET}" />`);
    await pause();
    process.stderr.write(`${`<node text="${SECRET}" />`.repeat(1_000)}</hierarchy>\n`);
  });

  assertPrivate(log);
  assert.ok(exit.stderrTail.includes('Caused by: binder has died'), exit.stderrTail);
  assert.equal(exit.snapshotContentRemoved, true);
  assert.equal(exit.stderrTruncated, true);
});

test('a helper failure that reports its own result keeps that report without a second record', async () => {
  const error = await captureError({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=false',
      'INSTRUMENTATION_RESULT: errorType=java.lang.IllegalStateException',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n'),
  });

  assert.equal(error.details?.instrumentation, undefined);
});

test('a session that exits before it is ready records its exit status and the output it printed', async () => {
  const { log } = await withLog(async (logPath) => {
    const base = createSessionProvider({ calls: [], processes: [] });
    const provider: AndroidAdbProvider = {
      ...base,
      spawn: () => {
        const process = new FakeAndroidProcess();
        setImmediate(() => {
          process.stdout.write(ABORTED_RUN);
          process.stderr.write('am: Killed\n');
          process.emitExit(1, null);
        });
        return process;
      },
    };
    await inScope(logPath, async () => {
      const output = await captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
      assert.equal(output, undefined);
    });
  });

  assert.deepEqual(
    exitResultOf(diagnosticData(log, 'android_snapshot_helper_session_start_failed')),
    {
      exitCode: 1,
      statusCode: 1,
      aborted: 'System has crashed.',
      stderrTail: 'am: Killed',
      stderrTruncated: false,
    },
  );
});

test('a session that exits after it was ready records its exit result', async () => {
  const { exit } = await sessionExit(async (process) => {
    process.stdout.write(CRASHED_RUN);
  });

  assert.equal(exit.exitCode, 1);
  assert.equal(exit.shortMsg, 'java.lang.IllegalStateException');
});

test('a session exit result includes output that arrives after the exit event', async () => {
  const { log } = await withLog(async (logPath) => {
    const processes: FakeAndroidProcess[] = [];
    const provider = createSessionProvider({ calls: [], processes });
    const capture = () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
    await inScope(logPath, async () => {
      assert.ok(await capture());
      const process = processes[0]!;
      process.exitCode = 1;
      process.emit('exit', 1, null);
      const second = capture();
      await pause();
      process.stdout.write(CRASHED_RUN);
      await pause();
      process.emit('close', 1, null);
      await second;
    });
  });

  const exit = exitResultOf(diagnosticData(log, 'android_snapshot_helper_session_exited'));
  assert.equal(exit.exitCode, 1);
  assert.equal(exit.shortMsg, 'java.lang.IllegalStateException');
});

test('a session that is stopped while it is still running records no invented cause', async () => {
  const { log } = await withLog(async (logPath) => {
    const provider = createSessionProvider({ calls: [], processes: [] });
    await inScope(logPath, async () => {
      await captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
      await resetAndroidSnapshotHelperSessions();
    });
  });

  assert.ok(!log.includes('android_snapshot_helper_session_exited'));
});

test('the request log entry for a failed capture carries the instrumentation result', async () => {
  const { result: caught, log } = await withLog(async (logPath) => {
    return await inScope(logPath, async () => {
      let thrown: unknown;
      await snapshotAndroid(emulator, {
        helperAdb: helperFailingWith({ exitCode: 1, stdout: ABORTED_RUN }),
        helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      }).catch((error: unknown) => {
        thrown = error;
      });
      return thrown as AppError;
    });
  });

  assert.equal(exitResultOf(caught.details ?? {}).aborted, 'System has crashed.');
  const logged = exitResultOf(diagnosticData(log, 'android_snapshot_helper_failed'));
  assert.equal(logged.exitCode, 1);
  assert.equal(logged.aborted, 'System has crashed.');
});
