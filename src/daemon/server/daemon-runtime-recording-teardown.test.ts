import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
  };
});
vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});

import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import { IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS } from '../handlers/record-trace-ios-simulator.ts';
import {
  resolveDaemonSessionTeardownTimeoutMs,
  teardownDaemonSessionForShutdown,
} from './daemon-runtime.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function makeRecordingSession(name: string): SessionState {
  const session: SessionState = {
    name,
    device: {
      platform: 'apple',
      id: 'sim-udid-shutdown',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
  session.recording = {
    platform: 'ios',
    outPath: path.join(os.tmpdir(), `${name}.mp4`),
    startedAt: Date.now() - 5_000,
    showTouches: false,
    gestureEvents: [],
    recorderPid: 4242,
    // Slow direct-handle path: the recorder never exits on its own, so the stop
    // must run the full SIGINT -> SIGTERM -> SIGKILL escalation.
    child: { kill: vi.fn(), pid: 4242 },
    wait: new Promise(() => {}),
  };
  return session;
}

test('daemon session teardown budget extends past the recorder-stop escalation for recording sessions', () => {
  const session = makeRecordingSession('budget-session');
  const withRecording = resolveDaemonSessionTeardownTimeoutMs(session);
  session.recording = undefined;
  const withoutRecording = resolveDaemonSessionTeardownTimeoutMs(session);

  // The base budget alone is shorter than the recorder-stop escalation, so a
  // recording session must get the base budget PLUS the full escalation.
  expect(withoutRecording).toBeLessThan(IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS);
  expect(withRecording - withoutRecording).toBeGreaterThanOrEqual(
    IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS,
  );
});

test('daemon shutdown lets a slow recorder run its full stop escalation instead of timing out', async () => {
  vi.useFakeTimers();
  const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-shutdown-recording-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'shutdown-slow-recorder-session';
  const session = makeRecordingSession(sessionName);
  const recording = session.recording;
  const kill = recording?.platform === 'ios' ? vi.mocked(recording.child.kill) : undefined;
  sessionStore.set(sessionName, session);
  const stderrChunks: string[] = [];
  const stderr = { write: (chunk: string) => stderrChunks.push(chunk) };

  try {
    const teardownPromise = teardownDaemonSessionForShutdown({
      session,
      sessionStore,
      stateDir: root,
      stderr,
    });
    // Advance past the full escalation (direct 5s wait + 3 x 2s retries) but
    // NOT past the extended per-session budget: the teardown must win the race.
    await vi.advanceTimersByTimeAsync(12_000);
    await teardownPromise;

    // The recorder was escalated all the way to SIGKILL before shutdown moved on.
    expect(kill?.mock.calls.map((call) => call[0])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(processKill.mock.calls.map((call) => call[1])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    // The extended budget covered the escalation: teardown completed (surfacing
    // the recorder-stop failure) rather than being abandoned by the timeout.
    expect(stderrChunks.join('')).toMatch(/Daemon session teardown error .*recording/);
    expect(stderrChunks.join('')).not.toMatch(/timed out/);
    expect(sessionStore.get(sessionName)).toBeUndefined();
  } finally {
    processKill.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
