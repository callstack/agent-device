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

const TRUNCATED_XML_RUN = [
  'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
  'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
  'INSTRUMENTATION_STATUS: chunkIndex=0',
  'INSTRUMENTATION_STATUS: chunkCount=1',
  `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from('<hierarchy rotation="0"><node text="Hel').toString('base64')}`,
  'INSTRUMENTATION_STATUS_CODE: 1',
  '',
].join('\n');

type FailedRun = { exitCode: number; stdout: string; stderr?: string; signal?: string };

type ExitResultFields = {
  exitCode: number | null;
  signal?: string;
  resultCode?: number;
  aborted?: string;
  failed?: string;
  shortMsg?: string;
  longMsg?: string;
  outputTail: string;
  outputTruncated: boolean;
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
  const error = await captureError(run);
  return error.details?.instrumentation as ExitResultFields;
}

function encodedPayload(xml: string): string {
  return `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml).toString('base64')}`;
}

const SECRET = 'hunter2-account-number';
const SECRET_XML = `<hierarchy rotation="0"><node text="${SECRET}" bounds="[0,0][10,10]" /></hierarchy>`;

test('an aborted instrumentation run reports the abort and the exit status', async () => {
  assert.deepEqual(await captureExitResult({ exitCode: 1, stdout: ABORTED_RUN }), {
    exitCode: 1,
    aborted: 'System has crashed.',
    outputTail: ABORTED_RUN.trimEnd(),
    outputTruncated: false,
  });
});

test('a crashed instrumentation run reports shortMsg, longMsg and the result code', async () => {
  assert.deepEqual(await captureExitResult({ exitCode: 0, stdout: CRASHED_RUN }), {
    exitCode: 0,
    resultCode: 0,
    shortMsg: 'java.lang.IllegalStateException',
    longMsg: 'java.lang.IllegalStateException: UiAutomation not connected',
    outputTail: CRASHED_RUN.trimEnd(),
    outputTruncated: false,
  });
});

test('the host signal that ended the run reaches the details', async () => {
  const result = await captureExitResult({ exitCode: 1, stdout: '', signal: 'SIGKILL' });

  assert.equal(result.signal, 'SIGKILL');
});

test('an empty INSTRUMENTATION_CODE is not recorded as a zero result', async () => {
  const result = await captureExitResult({
    exitCode: 1,
    stdout: 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: \n',
  });

  assert.equal(result.resultCode, undefined);
  assert.equal(result.shortMsg, 'Process crashed.');
});

test('multiline result values keep their continuation lines', async () => {
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
      'INSTRUMENTATION_RESULT: longMsg=java.lang.IllegalStateException: no root',
      '\tat android.app.UiAutomation.connect(UiAutomation.java:12)',
      '\tat com.callstack.agentdevice.snapshothelper.Main.<init>(Main.java:7)',
      'INSTRUMENTATION_CODE: 0',
    ].join('\n'),
  });
  assert.equal(
    stack.longMsg,
    [
      'java.lang.IllegalStateException: no root',
      '\tat android.app.UiAutomation.connect(UiAutomation.java:12)',
      '\tat com.callstack.agentdevice.snapshothelper.Main.<init>(Main.java:7)',
    ].join('\n'),
  );

  const interleaved = await captureExitResult({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_RESULT: longMsg=first line',
      'second line',
      encodedPayload(SECRET_XML),
      'INSTRUMENTATION_STATUS_CODE: 1',
      'not part of the message',
      'INSTRUMENTATION_CODE: 0',
    ].join('\n'),
  });
  assert.equal(interleaved.longMsg, 'first line\nsecond line');
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
    const result = await captureExitResult({ exitCode: 1, stdout: `${line}\n` });
    assert.equal(result.failed, expected, line);
  }
});

test('a truncated XML exit keeps its exit status and drops the snapshot payload', async () => {
  const details = (
    await captureError({
      exitCode: 1,
      stdout: `${'x'.repeat(20_000)}\n${TRUNCATED_XML_RUN}`,
      stderr: 'am: Killed',
    })
  ).details as { instrumentation: ExitResultFields };

  const instrumentation = details.instrumentation;
  assert.equal(instrumentation.exitCode, 1);
  assert.equal(instrumentation.outputTruncated, true);
  assert.ok(instrumentation.outputTail.length <= 400);
  assert.ok(instrumentation.outputTail.endsWith('am: Killed'));
  assert.ok(instrumentation.outputTail.includes('payloadBase64=<omitted>'));
});

test('encoded and raw snapshot content never reaches the error details', async () => {
  const runs = [
    {
      exitCode: 1,
      stdout: [
        'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
        encodedPayload(SECRET_XML),
        'INSTRUMENTATION_STATUS_CODE: 1',
      ].join('\n'),
      stderr: 'am: Killed',
    },
    {
      exitCode: 1,
      stdout: `INSTRUMENTATION_STATUS: stream=${SECRET_XML}\nINSTRUMENTATION_STATUS_CODE: 1`,
      stderr: '',
    },
    // An incomplete raw fragment, cut inside an attribute.
    { exitCode: 1, stdout: `<hierarchy rotation="0"><node text="${SECRET}`, stderr: 'am: Killed' },
  ];
  for (const run of runs) {
    const error = await captureError(run);
    const wire = JSON.stringify(normalizeError(error));
    assert.ok(!wire.includes(SECRET), wire);
    assert.ok(!wire.includes(Buffer.from(SECRET).toString('base64')), wire);
    assert.ok(!wire.includes(Buffer.from(SECRET_XML).toString('base64').slice(0, 24)), wire);
    assert.ok(wire.includes('am: Killed') || run.stderr === '', wire);
  }
});

test('a large one-line XML report never leaves a sensitive value in the details or the request log', async () => {
  const nodes = Array.from(
    { length: 400 },
    (_, index) => `<node index="${index}" text="row ${index}" bounds="[0,0][1,1]" />`,
  ).join('');
  const lateSecret = `<node text="${SECRET}" content-desc="account" bounds="[0,0][1,1]" />`;
  const stdouts = [
    `<hierarchy rotation="0">${nodes}${lateSecret}</hierarchy>`,
    // Cut so that the kept end of the report has no opening tag left.
    `${'a'.repeat(30_000)} text="${SECRET}" content-desc="account" bounds="[0,0][1,1]" />`,
    `INSTRUMENTATION_STATUS: stream=<hierarchy rotation="0">${nodes}${lateSecret}`,
  ];
  for (const stdout of stdouts) {
    const error = await captureError({ exitCode: 1, stdout, stderr: 'am: Killed' });
    const wire = JSON.stringify(normalizeError(error));
    assert.ok(!wire.includes(SECRET), wire.slice(-600));
    assert.ok(wire.includes('am: Killed'));

    const tmpDir = await mkdtempForTest('agent-device-android-capture-xml-diag-');
    const logPath = path.join(tmpDir, 'diag.ndjson');
    try {
      await withDiagnosticsScope(
        { debug: true, logPath, session: 'android-test', requestId: 'req-7', command: 'snapshot' },
        async () => {
          await assert.rejects(
            snapshotAndroid(emulator, {
              helperAdb: helperFailingWith({ exitCode: 1, stdout, stderr: 'am: Killed' }),
              helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
            }),
          );
        },
      );
      const log = await fs.readFile(logPath, 'utf8');
      assert.ok(log.includes('android_snapshot_helper_failed'));
      assert.ok(!log.includes(SECRET), log.slice(-600));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test('a single-line shortMsg or longMsg is held to the message cap', async () => {
  const result = await captureExitResult({
    exitCode: 0,
    stdout: `INSTRUMENTATION_RESULT: shortMsg=${'s'.repeat(10_000)}\nINSTRUMENTATION_RESULT: longMsg=${'l'.repeat(10_000)}\nINSTRUMENTATION_CODE: 0`,
  });

  assert.equal(result.shortMsg?.length, 2_048);
  assert.equal(result.longMsg?.length, 2_048);
});

test('an INSTRUMENTATION_CODE beyond the safe integer range is not recorded', async () => {
  const result = await captureExitResult({
    exitCode: 1,
    stdout: `INSTRUMENTATION_CODE: ${'9'.repeat(400)}\n`,
  });

  assert.equal(result.resultCode, undefined);
});

test('a session exit result includes output that arrives after the exit event', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-session-drain-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const processes: FakeAndroidProcess[] = [];
    const provider = createSessionProvider({ calls: [], processes });
    const capture = () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-8', command: 'snapshot' },
      async () => {
        assert.ok(await capture());
        const process = processes[0]!;
        process.exitCode = 1;
        process.emit('exit', 1, null);
        const second = capture();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        process.stdout.write(CRASHED_RUN);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        process.emit('close', 1, null);
        await second;
      },
    );

    const event = await readDiagnostic(logPath, 'android_snapshot_helper_session_exited');
    const exit = readExitResult(event.data ?? {});
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.shortMsg, 'java.lang.IllegalStateException');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the real cause past the redaction cap survives in the error and the request log', async () => {
  const filler = Array.from({ length: 40 }, (_, index) => `line ${index} of helper output`).join(
    '\n',
  );
  const stdout = `${filler}\nam: Killed by the low memory killer`;
  const error = await captureError({ exitCode: 1, stdout });

  const wire = normalizeError(error).details?.instrumentation as ExitResultFields;
  assert.ok(wire.outputTail.endsWith('am: Killed by the low memory killer'), wire.outputTail);
  assert.ok(wire.outputTail.length <= 400);
  assert.equal(wire.outputTruncated, true);

  const short = await captureError({ exitCode: 1, stdout: `${'y'.repeat(500)} done` });
  const shortWire = normalizeError(short).details?.instrumentation as ExitResultFields;
  assert.equal(shortWire.outputTruncated, true);
  assert.ok(shortWire.outputTail.endsWith('done'));

  const tmpDir = await mkdtempForTest('agent-device-android-exit-tail-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-3', command: 'snapshot' },
      async () => {
        const helperAdb = helperFailingWith({ exitCode: 1, stdout, stderr: '' });
        await assert.rejects(
          snapshotAndroid(emulator, {
            helperAdb,
            helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
          }),
        );
      },
    );
    const logged = readExitResult(
      (await readDiagnostic(logPath, 'android_snapshot_helper_failed')).data ?? {},
    );
    assert.ok(
      logged.outputTail?.endsWith('am: Killed by the low memory killer'),
      logged.outputTail,
    );
    assert.equal(logged.outputTruncated, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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

test('a session that exits before it is ready records its exit status and output tail', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-session-exit-diag-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const base = createSessionProvider({ calls: [], processes: [] });
    const provider: AndroidAdbProvider = {
      ...base,
      spawn: () => {
        const process = new FakeAndroidProcess();
        setImmediate(() => {
          process.stdout.write(ABORTED_RUN);
          process.emitExit(1, null);
        });
        return process;
      },
    };
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-1', command: 'snapshot' },
      async () => {
        const output = await captureAndroidSnapshotWithHelperSession({
          adb: provider.exec,
          adbProvider: provider,
          deviceKey: 'android:emulator-5556',
        });
        assert.equal(output, undefined);
      },
    );

    const event = await readDiagnostic(logPath, 'android_snapshot_helper_session_start_failed');
    assert.deepEqual(event.data?.instrumentation, {
      exitCode: 1,
      aborted: 'System has crashed.',
      outputTail: ABORTED_RUN.trimEnd(),
      outputTruncated: false,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('a session that exits after it was ready records its exit result and the output it printed', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-session-late-exit-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const processes: FakeAndroidProcess[] = [];
    const provider = createSessionProvider({ calls: [], processes });
    const capture = () =>
      captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: 'android:emulator-5556',
      });
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-4', command: 'snapshot' },
      async () => {
        assert.ok(await capture());
        processes[0]!.stdout.write(CRASHED_RUN);
        processes[0]!.emitExit(1, null);
        await capture();
      },
    );

    const event = await readDiagnostic(logPath, 'android_snapshot_helper_session_exited');
    const exit = readExitResult(event.data ?? {});
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.shortMsg, 'java.lang.IllegalStateException');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('a session that is stopped while it is still running records no invented cause', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-session-live-stop-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const provider = createSessionProvider({ calls: [], processes: [] });
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-5', command: 'snapshot' },
      async () => {
        await captureAndroidSnapshotWithHelperSession({
          adb: provider.exec,
          adbProvider: provider,
          deviceKey: 'android:emulator-5556',
        });
        await resetAndroidSnapshotHelperSessions();
      },
    );

    const log = await fs.readFile(logPath, 'utf8');
    assert.ok(!log.includes('android_snapshot_helper_session_exited'));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

const emulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5556',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

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

test('the request log entry for a failed capture carries the instrumentation result', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-capture-exit-diag-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const helperAdb = helperFailingWith({ exitCode: 1, stdout: ABORTED_RUN });
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-2', command: 'snapshot' },
      async () => {
        await assert.rejects(
          snapshotAndroid(emulator, {
            helperAdb,
            helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
          }),
          (error) => {
            const details = (error as { details: Record<string, unknown> }).details;
            assert.equal(readExitResult(details).aborted, 'System has crashed.');
            return true;
          },
        );
      },
    );

    const event = await readDiagnostic(logPath, 'android_snapshot_helper_failed');
    const logged = readExitResult(event.data ?? {});
    assert.equal(logged.exitCode, 1);
    assert.equal(logged.aborted, 'System has crashed.');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('encoded snapshot content never reaches the request log', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-capture-payload-diag-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const helperAdb = helperFailingWith({
      exitCode: 1,
      stdout: `${encodedPayload(SECRET_XML)}\nINSTRUMENTATION_STATUS_CODE: 1`,
    });
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-6', command: 'snapshot' },
      async () => {
        await assert.rejects(
          snapshotAndroid(emulator, {
            helperAdb,
            helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
          }),
        );
      },
    );
    const log = await fs.readFile(logPath, 'utf8');
    assert.ok(log.includes('android_snapshot_helper_failed'));
    assert.ok(!log.includes(Buffer.from(SECRET_XML).toString('base64').slice(0, 24)), log);
    assert.ok(!log.includes(SECRET));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

function readExitResult(fields: Record<string, unknown>): Partial<ExitResultFields> {
  return (fields.instrumentation ?? {}) as Partial<ExitResultFields>;
}

async function readDiagnostic(
  logPath: string,
  phase: string,
): Promise<{ data?: Record<string, unknown> }> {
  const log = await fs.readFile(logPath, 'utf8');
  const event = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; data?: Record<string, unknown> })
    .find((entry) => entry.phase === phase);
  assert.ok(event, `expected a ${phase} diagnostic`);
  return event;
}
