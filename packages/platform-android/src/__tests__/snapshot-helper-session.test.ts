import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import { captureAndroidSnapshotWithHelperSession } from '../snapshot-helper-session.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import { isAndroidSnapshotHelperRuntimeOccupiedError } from '../snapshot-helper-retirement.ts';
import {
  createSessionProvider,
  createPersistentSnapshotHelperProvider,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';

beforeEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  await resetAndroidSnapshotHelperSessions();
});

test('selects supported idle commands and keeps one helper across full, short and immediate captures', async () => {
  const cases = [
    {
      commands: ['snapshot-short-idle', 'snapshot-immediate'],
      expected: ['snapshot', 'snapshot', 'snapshot-short-idle', 'snapshot-immediate'],
    },
    {
      commands: ['snapshot-immediate'],
      expected: ['snapshot', 'snapshot', 'snapshot', 'snapshot-immediate'],
    },
    { commands: [], expected: ['snapshot', 'snapshot', 'snapshot', 'snapshot'] },
  ];
  for (const [index, scenario] of cases.entries()) {
    const sessionRequests: string[] = [];
    const spawnArgs: (readonly string[])[] = [];
    const provider = createPersistentSnapshotHelperProvider({
      calls: [],
      spawnArgs,
      processes: [],
      sessionRequests,
      sessionCommands: scenario.commands,
    });
    for (const [captureIndex, idleWait] of (
      [undefined, 'full', 'short', 'none'] as const
    ).entries()) {
      const output = await captureAndroidSnapshotWithHelperSession({
        adb: provider.exec,
        adbProvider: provider,
        deviceKey: `android:idle-policy-${index}`,
        idleWait,
      });
      assert.match(output?.xml ?? '', /persistent helper snapshot/);
      assert.equal(output?.metadata.sessionReused, captureIndex > 0);
    }
    assert.deepEqual(
      sessionRequests.map((request) => request.split(' ')[0]),
      scenario.expected,
    );
    assert.equal(spawnArgs.length, 1, 'per-request idle policy must not restart the helper');
  }
});

test('allows a persistent session snapshot to use the helper command budget', async () => {
  const calls: (readonly string[])[] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 25 });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 4_000,
  });

  assert.match(output?.xml ?? '', /snapshot 1/);
  assert.equal(output?.metadata.transport, 'persistent-session');
  assert.equal(output?.metadata.sessionReused, false);
});

test('retires a persistent session that exceeds the helper command budget', async () => {
  const calls: (readonly string[])[] = [];
  const provider = createSessionProvider({ calls, responseDelayMs: 50 });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    timeoutMs: 10,
    commandTimeoutMs: 20,
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

// A cancellation lands wherever the caller's deadline falls (#4030): before the helper reports
// ready, or while the helper holds the snapshot request it never answers.
for (const cancelPoint of ['before the helper is ready', 'while the helper stalls'] as const) {
  test(`cancels a capture ${cancelPoint}, retires its helper, and starts the next capture cleanly`, async () => {
    const calls: (readonly string[])[] = [];
    const processes: FakeAndroidProcess[] = [];
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('wait deadline exceeded'));
    const provider = createSessionProvider({
      calls,
      processes,
      stalledSnapshots: 1,
      ...(cancelPoint === 'while the helper stalls' ? { onStalledSnapshot: cancel } : {}),
    });
    const capture = captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: {
        ...provider,
        spawn: (args, options) => {
          const process = provider.spawn!(args, options);
          if (cancelPoint === 'before the helper is ready') cancel();
          return process;
        },
      },
      deviceKey: 'android:emulator-5554',
      signal: controller.signal,
    });

    await assert.rejects(capture, /wait deadline exceeded/);
    assert.equal(processes[0]?.killed, true);
    assert.equal(
      calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
      true,
    );

    const next = await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: 'android:emulator-5554',
    });
    assert.match(next?.xml ?? '', /snapshot 1/);
    assert.equal(next?.metadata.sessionReused, false);
    assert.equal(processes.length, 2);
  });
}

test('canceled capture joins canceled external cleanup before returning', async () => {
  const calls: (readonly string[])[] = [];
  const cleanupAborts: (readonly string[])[] = [];
  const controller = new AbortController();
  const provider = createSessionProvider({
    calls,
    cleanupAborts,
    stalledSnapshots: 1,
    stalledCleanup: true,
    onStalledSnapshot: () => controller.abort(new Error('wait deadline exceeded')),
  });
  const capture = captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
    signal: controller.signal,
  });

  const outcome = await Promise.race([
    capture.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 750)),
  ]);

  assert.equal(outcome, 'rejected');
  assert.equal(cleanupAborts.length, 2);
});

test('release the transport could not confirm falls back instead of failing the capture', async () => {
  const calls: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  // An adb that cannot forward the device exit status, and a device that cannot be read back:
  // neither says anything about who owns UiAutomation, so neither may answer for this capture.
  const provider = createSessionProvider({
    calls,
    processes,
    recoveryFailure: true,
    responseMode: 'malformed',
    shellProtocolV2: false,
    runtimeRelease: 'unreadable',
  });

  for (const attempt of [1, 2]) {
    const output = await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: 'android:emulator-5554',
    });
    assert.equal(output, undefined, `attempt ${attempt}`);
  }
  // The malformed answer backs the session off, so the second command goes straight to one-shot.
  assert.equal(processes.length, 1);
});

test('capture refuses a device the previous teardown found the helper still running', async () => {
  const calls: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    responseMode: 'malformed',
    shellProtocolV2: false,
    runtimeRelease: 'occupied',
  });

  const failed = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });
  assert.equal(failed, undefined);

  await assert.rejects(
    captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey: 'android:emulator-5554',
    }),
    isAndroidSnapshotHelperRuntimeOccupiedError,
  );
});

test('allows device retirement beyond host-process grace before falling back', async () => {
  const calls: (readonly string[])[] = [];
  const processes: FakeAndroidProcess[] = [];
  const provider = createSessionProvider({
    calls,
    processes,
    responseMode: 'ui-automation-timeout',
    forceStopDelayMs: 300,
  });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(processes[0]?.killed, true);
});

test('invalidates and falls back from the helper session after a malformed response', async () => {
  const calls: (readonly string[])[] = [];
  const provider = createSessionProvider({ calls, responseMode: 'malformed' });

  const output = await captureAndroidSnapshotWithHelperSession({
    adb: provider.exec,
    adbProvider: provider,
    deviceKey: 'android:emulator-5554',
  });

  assert.equal(output, undefined);
  assert.equal(
    calls.some((args) => args[0] === 'forward' && args[1] === '--remove'),
    true,
  );
});

/**
 * The session fallback diagnostic must read the typed reason its own protocol published, not
 * re-compare the helper's error type. A second comparison is a second taxonomy, and it drifts the
 * first time either side changes (#1983).
 */
test('the session fallback diagnostic reads the typed timeout reason', async () => {
  const tmpDir = await mkdtempForTest('agent-device-android-session-timeout-diag-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    const processes: FakeAndroidProcess[] = [];
    const provider = createSessionProvider({
      calls: [],
      processes,
      responseMode: 'ui-automation-timeout',
    });

    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-1', command: 'snapshot' },
      async () => {
        const output = await captureAndroidSnapshotWithHelperSession({
          adb: provider.exec,
          adbProvider: provider,
          deviceKey: 'android:emulator-5554',
        });
        assert.equal(output, undefined);
      },
    );

    const log = await fs.readFile(logPath, 'utf8');
    const fallback = log
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { phase?: string; data?: Record<string, unknown> })
      .find((event) => event.phase === 'android_snapshot_helper_session_fallback');
    assert.ok(fallback, 'expected a session fallback diagnostic');
    assert.equal(fallback.data?.uiAutomationConnectionTimeout, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
