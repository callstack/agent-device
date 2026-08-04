import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, test, vi } from 'vitest';

import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import type { RecordTraceDeps } from '../record-trace-types.ts';
import { startIosSimulatorRecording } from '../record-trace-ios-simulator-recording.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('startIosSimulatorRecording waits for the zero-byte simctl destination before reporting ready', async () => {
  vi.useFakeTimers();
  const testStartedAt = Date.now();
  const root = makeTemporaryRoot('agent-device-record-ready-');
  const outPath = path.join(root, 'recording.mp4');
  const kill = vi.fn((_signal?: NodeJS.Signals) => true);
  const wait = new Promise<never>(() => {});
  setTimeout(() => fs.writeFileSync(outPath, ''), 600);

  const resultPromise = startIosSimulatorRecording({
    req: {
      token: 'test-token',
      session: 'record-ready',
      command: 'record',
      positionals: ['start', outPath],
      flags: {},
    },
    activeSession: {
      name: 'record-ready',
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      appBundleId: 'com.example.app',
    },
    device: IOS_SIMULATOR,
    deps: makeDeps({
      startIosSimulatorRecording: () => ({
        child: { kill, pid: 1234 },
        wait,
      }),
    }),
    recordingBase: {
      outPath,
      startedAt: 0,
      showTouches: false,
      gestureEvents: [],
    },
    resolvedOut: outPath,
  });

  await vi.advanceTimersByTimeAsync(800);
  const result = await resultPromise;
  assert.ok(!('ok' in result), JSON.stringify(result));
  assert.equal(result.platform, 'ios');
  assert.equal(result.startedAt, testStartedAt + 750);
  assert.equal(kill.mock.calls.length, 0);
});

test('startIosSimulatorRecording reports an early recorder exit instead of a false start', async () => {
  const root = makeTemporaryRoot('agent-device-record-exit-');
  const outPath = path.join(root, 'recording.mp4');
  const result = await startIosSimulatorRecording({
    req: {
      token: 'test-token',
      session: 'record-exit',
      command: 'record',
      positionals: ['start', outPath],
      flags: {},
    },
    activeSession: {
      name: 'record-exit',
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      appBundleId: 'com.example.app',
    },
    device: IOS_SIMULATOR,
    deps: makeDeps({
      startIosSimulatorRecording: () => ({
        child: { kill: vi.fn(() => true), pid: 1234 },
        wait: Promise.resolve({ stdout: '', stderr: 'capture unavailable', exitCode: 1 }),
      }),
    }),
    recordingBase: {
      outPath,
      startedAt: 0,
      showTouches: false,
      gestureEvents: [],
    },
    resolvedOut: outPath,
  });

  assert.equal('ok' in result && result.ok, false);
  assert.match(JSON.stringify(result), /failed to start recording: capture unavailable/);
});

test('startIosSimulatorRecording escalates cleanup when its wait monitor rejects', async () => {
  const root = makeTemporaryRoot('agent-device-record-wait-failed-');
  const outPath = path.join(root, 'recording.mp4');
  const kill = vi.fn((_signal?: NodeJS.Signals) => true);
  const result = await startIosSimulatorRecording({
    req: {
      token: 'test-token',
      session: 'record-wait-failed',
      command: 'record',
      positionals: ['start', outPath],
      flags: {},
    },
    activeSession: {
      name: 'record-wait-failed',
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      appBundleId: 'com.example.app',
    },
    device: IOS_SIMULATOR,
    deps: makeDeps({
      startIosSimulatorRecording: () => ({
        child: { kill, pid: 1234 },
        wait: Promise.reject(new Error('recorder wait monitor failed')),
      }),
    }),
    recordingBase: {
      outPath,
      startedAt: 0,
      showTouches: false,
      gestureEvents: [],
    },
    resolvedOut: outPath,
  });

  assert.equal('ok' in result && result.ok, false);
  assert.match(JSON.stringify(result), /recorder wait monitor failed/);
  assert.deepEqual(kill.mock.calls, [['SIGINT'], ['SIGTERM'], ['SIGKILL']]);
});

test.each([
  { exitCode: 0, exitDelayMs: 0 },
  { exitCode: 1, exitDelayMs: 0 },
  { exitCode: 1, exitDelayMs: 25 },
])(
  'startIosSimulatorRecording rejects recorder exit code $exitCode after $exitDelayMs ms when its destination exists',
  async ({ exitCode, exitDelayMs }) => {
    if (exitDelayMs > 0) vi.useFakeTimers();
    const root = makeTemporaryRoot('agent-device-record-file-exit-');
    const outPath = path.join(root, 'recording.mp4');
    fs.writeFileSync(outPath, '');
    const wait =
      exitDelayMs === 0
        ? Promise.resolve({ stdout: '', stderr: 'recorder exited', exitCode })
        : new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
            setTimeout(
              () => resolve({ stdout: '', stderr: 'recorder exited', exitCode }),
              exitDelayMs,
            );
          });

    const resultPromise = startIosSimulatorRecording({
      req: {
        token: 'test-token',
        session: 'record-file-exit',
        command: 'record',
        positionals: ['start', outPath],
        flags: {},
      },
      activeSession: {
        name: 'record-file-exit',
        device: IOS_SIMULATOR,
        createdAt: Date.now(),
        actions: [],
        appBundleId: 'com.example.app',
      },
      device: IOS_SIMULATOR,
      deps: makeDeps({
        startIosSimulatorRecording: () => ({
          child: { kill: vi.fn(() => true), pid: 1234 },
          wait,
        }),
      }),
      recordingBase: {
        outPath,
        startedAt: 0,
        showTouches: false,
        gestureEvents: [],
      },
      resolvedOut: outPath,
    });
    if (exitDelayMs > 0) await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    assert.equal('ok' in result && result.ok, false);
    assert.match(JSON.stringify(result), /failed to start recording/);
    assert.equal(fs.existsSync(outPath), false);
  },
);

test('startIosSimulatorRecording times out and cleans up a recorder that never becomes ready', async () => {
  vi.useFakeTimers();
  const root = makeTemporaryRoot('agent-device-record-timeout-');
  const outPath = path.join(root, 'recording.mp4');
  const kill = vi.fn((_signal?: NodeJS.Signals) => true);
  const resultPromise = startIosSimulatorRecording({
    req: {
      token: 'test-token',
      session: 'record-timeout',
      command: 'record',
      positionals: ['start', outPath],
      flags: {},
    },
    activeSession: {
      name: 'record-timeout',
      device: IOS_SIMULATOR,
      createdAt: Date.now(),
      actions: [],
      appBundleId: 'com.example.app',
    },
    device: IOS_SIMULATOR,
    deps: makeDeps({
      startIosSimulatorRecording: () => ({
        child: { kill, pid: undefined },
        wait: new Promise<never>(() => {}),
      }),
    }),
    recordingBase: {
      outPath,
      startedAt: 0,
      showTouches: false,
      gestureEvents: [],
    },
    resolvedOut: outPath,
  });

  // Let the readiness loop schedule its first fake-timer poll before advancing
  // the clock. Unlike the success case above, this test has no independent
  // timer to yield that initial microtask turn.
  await Promise.resolve();
  await vi.runAllTimersAsync();
  const result = await resultPromise;

  assert.equal('ok' in result && result.ok, false);
  assert.match(JSON.stringify(result), /did not create its output within 15000ms/);
  assert.deepEqual(
    kill.mock.calls.map(([signal]) => signal),
    ['SIGINT', 'SIGTERM', 'SIGKILL'],
  );
  assert.equal(fs.existsSync(outPath), false);
});

function makeDeps(overrides: Pick<RecordTraceDeps, 'startIosSimulatorRecording'>): RecordTraceDeps {
  return {
    runCmd: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    startIosSimulatorRecording: overrides.startIosSimulatorRecording,
    runAppleRunnerCommand: async () => ({}),
    waitForRecordingTail: async () => {},
    waitForStableFile: async () => {},
    isPlayableVideo: async () => true,
    trimRecordingStart: async () => {},
    resizeRecording: async () => {},
    overlayRecordingTouches: async () => {},
  };
}

function makeTemporaryRoot(prefix: string): string {
  const root = mkdtempForTestSync(prefix);
  temporaryRoots.push(root);
  return root;
}
