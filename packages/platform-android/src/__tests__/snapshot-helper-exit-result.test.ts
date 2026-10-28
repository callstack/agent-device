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

function captureWith(result: { exitCode: number; stdout: string; stderr?: string }) {
  return captureAndroidSnapshotWithHelper({
    adb: async () => ({ stderr: '', ...result }),
  });
}

async function captureDetails(result: {
  exitCode: number;
  stdout: string;
  stderr?: string;
}): Promise<Record<string, unknown>> {
  try {
    await captureWith(result);
  } catch (error) {
    return (error as { details: Record<string, unknown> }).details;
  }
  throw new Error('expected the capture to fail');
}

test('an aborted instrumentation run reports the abort and the exit status', async () => {
  const details = await captureDetails({ exitCode: 1, stdout: ABORTED_RUN });

  assert.deepEqual(details.instrumentation, {
    exitCode: 1,
    aborted: 'System has crashed.',
    outputTail: ABORTED_RUN,
    outputTruncated: false,
  });
});

test('a crashed instrumentation run reports shortMsg, longMsg and the result code', async () => {
  const details = await captureDetails({ exitCode: 0, stdout: CRASHED_RUN });

  assert.deepEqual(details.instrumentation, {
    exitCode: 0,
    resultCode: 0,
    shortMsg: 'java.lang.IllegalStateException',
    longMsg: 'java.lang.IllegalStateException: UiAutomation not connected',
    outputTail: CRASHED_RUN,
    outputTruncated: false,
  });
});

test('a truncated XML exit keeps its exit status and only a bounded tail of the snapshot', async () => {
  const bulk = `${'x'.repeat(20_000)}\n`;
  const details = await captureDetails({
    exitCode: 1,
    stdout: bulk + TRUNCATED_XML_RUN,
    stderr: 'am: Killed',
  });

  const instrumentation = details.instrumentation as {
    exitCode: number;
    outputTail: string;
    outputTruncated: boolean;
  };
  assert.equal(instrumentation.exitCode, 1);
  assert.equal(instrumentation.outputTruncated, true);
  assert.ok(instrumentation.outputTail.length <= 4_096);
  assert.ok(instrumentation.outputTail.endsWith('am: Killed'));
  assert.ok(!instrumentation.outputTail.includes('x'.repeat(5_000)));
});

test('a helper failure that reports its own result keeps that report without a second record', async () => {
  const details = await captureDetails({
    exitCode: 0,
    stdout: [
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=false',
      'INSTRUMENTATION_RESULT: errorType=java.lang.IllegalStateException',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n'),
  });

  assert.equal(details.instrumentation, undefined);
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
      // The request log trims string values.
      outputTail: ABORTED_RUN.trimEnd(),
      outputTruncated: false,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('the request log entry for a failed capture carries the instrumentation result', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-capture-exit-diag-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const helperAdb: AndroidAdbExecutor = async (args) => {
      if (args.includes('--show-versioncode')) {
        return {
          exitCode: 0,
          stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
          stderr: '',
        };
      }
      if (isAndroidHelperRuntimeProbe(args)) return androidHelperRuntimeProbeResult();
      if (isAndroidHelperRuntimeForceStop(args)) return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 1, stdout: ABORTED_RUN, stderr: '' };
    };
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-2', command: 'snapshot' },
      async () => {
        await assert.rejects(
          snapshotAndroid(
            {
              platform: 'android',
              id: 'emulator-5556',
              name: 'Pixel',
              kind: 'emulator',
              booted: true,
            },
            { helperAdb, helperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
          ),
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

function readExitResult(fields: Record<string, unknown>): {
  exitCode?: number;
  aborted?: string;
} {
  return (fields.instrumentation ?? {}) as { exitCode?: number; aborted?: string };
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
