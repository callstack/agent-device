import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import {
  captureAndroidSnapshotWithHelper,
  parseAndroidSnapshotHelperOutput,
} from '../snapshot-helper-capture.ts';
import { runCmd } from '@agent-device/host-kit/command';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { waitForAndroidSnapshotHelperSessionReady } from '../snapshot-helper-session-protocol.ts';
import { recordInstrumentationProcess } from '../instrumentation-helper.ts';
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

/** The AppError a promise rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error;
  }
  throw new Error('expected the promise to reject');
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
  });
});

test('a crashed instrumentation run reports shortMsg, longMsg and the result code', async () => {
  assert.deepEqual(await captureExitResult({ exitCode: 0, stdout: CRASHED_RUN }), {
    exitCode: 0,
    resultCode: 0,
    shortMsg: 'java.lang.IllegalStateException',
    longMsg: 'java.lang.IllegalStateException: UiAutomation not connected',
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

test('a sensitive value never reaches the details or the log wherever the helper printed it', async () => {
  const quoted = `${'p'.repeat(1_015)}password="${SECRET}" trailing`;
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
    // A tagless fragment as a free line.
    { exitCode: 1, stdout: `ret" text="${SECRET}" bounds="[0,0][1,1]" />\n` },
    // Fragments on stderr, including a role-description attribute and a quoted value whose key a
    // line cut would have removed.
    { exitCode: 1, stdout: '', stderr: `ret" text="${SECRET}" bounds="[0,0][1,1]" />` },
    { exitCode: 1, stdout: '', stderr: `ret" role-description="${SECRET}" />` },
    { exitCode: 1, stdout: '', stderr: quoted },
    { exitCode: 1, stdout: '', stderr: `${'a'.repeat(30_000)}${SECRET_XML}` },
    // A hierarchy cut off in front of a startup-failure marker.
    {
      exitCode: 1,
      stdout: '',
      stderr: `<hierarchy><node text="${SECRET}" INSTRUMENTATION_FAILED: ${SECRET}`,
    },
    {
      exitCode: 1,
      stdout: '',
      stderr: `android.util.AndroidException: INSTRUMENTATION_FAILED: <node text="${SECRET}"`,
    },
  ];
  for (const run of runs) {
    const withKill = { ...run, stderr: `${run.stderr ?? ''}\nam: Killed` };
    const error = await captureError(withKill);
    const wire = JSON.stringify(normalizeError(error));
    assertPrivate(wire);
    assert.equal(exitResultOf(normalizeError(error).details ?? {}).failed, undefined);

    const { log } = await withLog(async (logPath) => {
      await inScope(logPath, async () => {
        await assert.rejects(
          snapshotAndroid(emulator, {
            helperAdb: helperFailingWith(withKill),
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
});

test('a startup failure attaches no raw helper stream to its details or the log', async () => {
  const printed = (process: FakeAndroidProcess) => {
    process.stdout.write(`${encodedPayload(SECRET_XML)}\n`);
    process.stdout.write(`INSTRUMENTATION_STATUS: stream=${SECRET_XML}\n`);
    process.stdout.write(`ret" text="${SECRET}" bounds="[0,0][1,1]" />\n`);
    process.stderr.write(`ret" content-desc="${SECRET}" bounds="[0,0][1,1]" />\nam: Killed\n`);
  };
  const waitFor = (process: FakeAndroidProcess, timeoutMs: number) =>
    waitForAndroidSnapshotHelperSessionReady(
      process,
      timeoutMs,
      undefined,
      recordInstrumentationProcess(process),
    );

  const exited = new FakeAndroidProcess();
  const exitedFailure = rejection(waitFor(exited, 5_000));
  printed(exited);
  await pause();
  exited.emitExit(1, null);
  const exitedError = await exitedFailure;
  assertPrivate(JSON.stringify(normalizeError(exitedError)));
  assert.equal('output' in (exitedError.details ?? {}), false);
  assert.equal(exitResultOf(exitedError.details ?? {}).exitCode, 1);

  const stalled = new FakeAndroidProcess();
  const stalledFailure = rejection(waitFor(stalled, 50));
  printed(stalled);
  const stalledError = await stalledFailure;
  assertPrivate(JSON.stringify(normalizeError(stalledError)));
  assert.equal('output' in (stalledError.details ?? {}), false);
  assert.equal(exitResultOf(stalledError.details ?? {}).exitCode, null);

  const { log } = await withLog(async (logPath) => {
    const base = createSessionProvider({ calls: [], processes: [] });
    const provider: AndroidAdbProvider = {
      ...base,
      spawn: () => {
        const process = new FakeAndroidProcess();
        setImmediate(() => {
          printed(process);
          process.emitExit(1, null);
        });
        return process;
      },
    };
    await inScope(logPath, async () => {
      await captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
    });
  });
  assertPrivate(log);
  assert.equal(
    exitResultOf(diagnosticData(log, 'android_snapshot_helper_session_start_failed')).exitCode,
    1,
  );
});

test('a nonzero exit after parseable helper output keeps no raw stream in its details', async () => {
  const xml = `<hierarchy rotation="0"><node text="${SECRET}" bounds="[0,0][1,1]" /></hierarchy>`;
  const stdout = [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml).toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_CODE: -1',
  ].join('\n');
  const error = await captureError({ exitCode: 1, stdout, stderr: 'am: Killed' });

  assertPrivate(JSON.stringify(normalizeError(error)));
  assert.equal(error.details?.stdout, '');
  assert.equal(error.details?.stderr, '');
  assert.equal(error.details?.exitCode, 1);
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

test('a malformed helper report names its size, never the snapshot text it held', () => {
  const stdout = [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(`<node text="${SECRET}" />`).toString('base64')}`,
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: ok=true',
  ].join('\n');

  assert.throws(
    () => parseAndroidSnapshotHelperOutput(stdout),
    (error: unknown) => {
      assertPrivate(JSON.stringify(normalizeError(error)));
      return error instanceof AppError && typeof error.details?.xmlLength === 'number';
    },
  );
});

test('a helper report with ok=true but no XML chunks still carries the instrumentation result', async () => {
  const error = await captureError({
    exitCode: 1,
    stdout: [
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=true',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n'),
    stderr: 'am: Killed',
  });

  const result = exitResultOf(error.details ?? {});
  assert.equal(result.exitCode, 1);
  assert.equal(result.resultCode, -1);
});

test('a ready timeout in the middle of a record leaves the final fields intact', async () => {
  const child = new FakeAndroidProcess();
  const record = recordInstrumentationProcess(child);
  const failure = rejection(waitForAndroidSnapshotHelperSessionReady(child, 30, undefined, record));
  child.stdout.write('INSTRUMENTATION_RESULT: longMsg=UiAutomation fai');
  const timedOut = await failure;

  assert.equal(exitResultOf(timedOut.details ?? {}).longMsg, undefined);

  child.stdout.write('led\nCaused by: binder has died\nINSTRUMENTATION_CODE: 0\n');
  await pause();
  child.emitExit(1, null);
  await record.closed;
  const final = record.exitResult();
  assert.equal(final?.longMsg, 'UiAutomation failed\nCaused by: binder has died');
  assert.equal(final?.resultCode, 0);
});

test('startup failures are read from stderr only through a strict whole-line envelope', async () => {
  const component = 'com.example/.Missing$Inner';
  for (const line of [
    `android.util.AndroidException: INSTRUMENTATION_FAILED: ${component}`,
    `onError: commandError=true message=INSTRUMENTATION_FAILED: ${component}`,
  ]) {
    const result = await captureExitResult({ exitCode: 1, stdout: '', stderr: `${line}\n` });
    assert.equal(result.failed, component, line);
  }
  for (const line of [
    `android.util.AndroidException: INSTRUMENTATION_FAILED: <node text="${SECRET}">`,
    `<hierarchy><node text="${SECRET}" INSTRUMENTATION_FAILED: ${SECRET}`,
    `log: android.util.AndroidException: INSTRUMENTATION_FAILED: ${component}`,
    'android.util.AndroidException: INSTRUMENTATION_FAILED: has spaces',
  ]) {
    const result = await captureExitResult({ exitCode: 1, stdout: '', stderr: `${line}\n` });
    assert.equal(result.failed, undefined, line);
  }
});

test('a helper that prints chunks and then times out in the executor leaks no stream', async () => {
  const script =
    'process.stdout.write(process.env.PRINTED_STDOUT); process.stderr.write(process.env.PRINTED_STDERR); setTimeout(() => {}, 10_000);';
  const env = {
    ...process.env,
    PRINTED_STDOUT: `${encodedPayload(SECRET_XML)}\nINSTRUMENTATION_STATUS_CODE: 1\n`,
    PRINTED_STDERR: `ret" text="${SECRET}" />\n`,
  };
  let caught: AppError | undefined;
  try {
    await captureAndroidSnapshotWithHelper({
      adb: async () => await runCmd(process.execPath, ['-e', script], { timeoutMs: 600, env }),
    });
  } catch (error) {
    caught = error as AppError;
  }

  assert.ok(caught instanceof AppError);
  const wire = normalizeError(caught);
  assertPrivate(JSON.stringify(wire));
  assert.equal('stdout' in (caught.details ?? {}), false);
  assert.equal('stderr' in (caught.details ?? {}), false);
  assert.equal(caught.details?.timeoutMs, 600);
  assert.equal(exitResultOf(caught.details ?? {}).statusCode, 1);
});

test('a session that exits while its streams stay open still fails startup promptly', async () => {
  const child = new FakeAndroidProcess();
  const controller = new AbortController();
  const failure = rejection(
    waitForAndroidSnapshotHelperSessionReady(
      child,
      5_000,
      controller.signal,
      recordInstrumentationProcess(child),
    ),
  );
  child.stdout.write('INSTRUMENTATION_ABORTED: System has crashed.\n');
  await pause();
  child.exitCode = 1;
  child.emit('exit', 1, null);

  const startedAt = Date.now();
  const error = await failure;

  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(exitResultOf(error.details ?? {}).exitCode, 1);
  assert.equal(exitResultOf(error.details ?? {}).aborted, 'System has crashed.');
});

test('a failed live session is retired without waiting for an exit', async () => {
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({ calls: [], processes, responseMode: 'malformed' });

  const startedAt = Date.now();
  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5556',
  });

  assert.equal(output, undefined);
  assert.ok(Date.now() - startedAt < 200, `retirement took ${Date.now() - startedAt}ms`);
});
