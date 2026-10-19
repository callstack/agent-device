import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import type { AppError } from '@agent-device/kernel/errors';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetached: vi.fn(),
  runCmdSync: vi.fn(),
}));
// Host-kit's own suite proves what each host answer means; this one owns the Metro half: the
// budgets it hands over, and what the readiness failure says about what the stop came back with.
vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  readProcessStartTime: vi.fn(),
  stopProcessAndConfirmExit: vi.fn(),
}));

import { runCmdDetached } from '@agent-device/host-kit/command';
import {
  readProcessStartTime,
  stopProcessAndConfirmExit,
  type ConfirmedProcessStop,
} from '@agent-device/host-kit/process';

import { prepareMetroRuntime } from './client-metro.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SPAWNED_METRO_PID = 987;
const SPAWNED_METRO_START = 'Mon Oct 13 00:00:00 2026';
const METRO_STOP_BUDGET = { termTimeoutMs: 1_000, killTimeoutMs: 1_000 };

function createMetroProject(label: string): string {
  const tempRoot = mkdtempForTestSync(`agent-device-metro-startup-cleanup-${label}-`);
  const projectRoot = path.join(tempRoot, 'project');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-cleanup-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );
  return projectRoot;
}

function metroPrepareInput(projectRoot: string) {
  return {
    projectRoot,
    publicBaseUrl: 'https://public.example.test',
    metroPort: 8081,
    reuseExisting: true,
    installDependenciesIfNeeded: false,
    probeTimeoutMs: 10,
    startupTimeoutMs: 30_000,
    env: { ...process.env, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'daemon-token' },
  } as const;
}

/**
 * Runs a prepare whose Metro never becomes ready and hands back the failure it rejected with, so a
 * case can read the cleanup verdict off the readiness failure. Fake timers keep the budget virtual.
 */
async function runMetroPrepareThroughTimeout(projectRoot: string): Promise<AppError> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'packager-status:not-running',
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  const preparePromise = prepareMetroRuntime(
    metroPrepareInput(projectRoot),
    createTestHostEnvironment(),
  );
  const expectedFailure = assert.rejects(
    preparePromise,
    /React Native dev server did not become ready at http:\/\/127\.0\.0\.1:8081\/status within 30000ms/,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await expectedFailure;
  return (await preparePromise.catch((error: unknown) => error)) as AppError;
}

/** What the readiness failure's `details` must carry; undefined keys pin what must stay absent. */
const NO_CLEANUP = { reason: undefined, signal: undefined, errno: undefined, pid: undefined };

function cleanupDetails(error: AppError): Record<string, unknown> {
  const details = error.details ?? {};
  return { reason: details.reason, signal: details.signal, errno: details.errno, pid: details.pid };
}

/**
 * Every cleanup outcome, read off the readiness failure it decorates: the message names the pid that
 * still holds the port and `details` is what a caller dispatches on.
 */
test.each([
  {
    name: 'the cleanup confirmed the exit',
    stop: { status: 'stopped' } satisfies ConfirmedProcessStop,
    says: '',
    details: NO_CLEANUP,
  },
  {
    name: 'a signal was refused',
    stop: {
      status: 'retained',
      reason: 'signal-failed',
      signal: 'SIGTERM',
      errno: 'EPERM',
    } satisfies ConfirmedProcessStop,
    says: 'Dev server pid 987 is still running and refused SIGTERM (EPERM)',
    details: { reason: 'signal-failed', signal: 'SIGTERM', errno: 'EPERM', pid: SPAWNED_METRO_PID },
  },
  {
    // SIGTERM is accepted, then refused on the escalation: the verdict carries the later signal.
    name: 'only the escalation was refused',
    stop: {
      status: 'retained',
      reason: 'signal-failed',
      signal: 'SIGKILL',
      errno: 'EPERM',
    } satisfies ConfirmedProcessStop,
    says: 'Dev server pid 987 is still running and refused SIGKILL (EPERM)',
    details: { reason: 'signal-failed', signal: 'SIGKILL', errno: 'EPERM', pid: SPAWNED_METRO_PID },
  },
  {
    // The host would not say when the child started, so nothing proves the pid is still ours: the
    // stop retains it instead of signaling whatever process has inherited the pid by now.
    name: 'the cleanup could not establish the identity',
    stop: {
      status: 'retained',
      reason: 'identity-unverified',
    } satisfies ConfirmedProcessStop,
    says: 'could not be confirmed as the process this run started',
    details: {
      reason: 'identity-unverified',
      signal: undefined,
      errno: undefined,
      pid: SPAWNED_METRO_PID,
    },
  },
  {
    name: 'the process outlived both budgets',
    stop: {
      status: 'retained',
      reason: 'exit-timeout',
      signal: 'SIGKILL',
    } satisfies ConfirmedProcessStop,
    says: 'Dev server pid 987 is still running',
    details: {
      reason: 'exit-timeout',
      signal: 'SIGKILL',
      errno: undefined,
      pid: SPAWNED_METRO_PID,
    },
  },
])(
  'prepareMetroRuntime reports a dev server to reap when $name',
  async ({ stop, says, details }) => {
    const projectRoot = createMetroProject('outcome');
    vi.mocked(runCmdDetached).mockReturnValue(SPAWNED_METRO_PID);
    vi.mocked(readProcessStartTime).mockReturnValue(SPAWNED_METRO_START);
    vi.mocked(stopProcessAndConfirmExit).mockResolvedValue(stop);

    try {
      const failure = await runMetroPrepareThroughTimeout(projectRoot);
      if (says) assert.ok(failure.message.includes(says), failure.message);
      else assert.doesNotMatch(failure.message, /still running/);
      assert.deepEqual(cleanupDetails(failure), details);
      assert.deepEqual(vi.mocked(stopProcessAndConfirmExit).mock.calls, [
        [
          { pid: SPAWNED_METRO_PID, identity: { startTime: SPAWNED_METRO_START } },
          METRO_STOP_BUDGET,
        ],
      ]);
    } finally {
      fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
    }
  },
);

// Cleanup stays best effort: an unclassifiable host fault is the cause, never a replacement for the
// readiness failure and its log path, which is what the user acts on.
test('prepareMetroRuntime keeps the readiness failure when cleanup faults', async () => {
  const projectRoot = createMetroProject('host-fault');
  const fault = new TypeError('kill refused: bad signal');
  vi.mocked(runCmdDetached).mockReturnValue(SPAWNED_METRO_PID);
  vi.mocked(stopProcessAndConfirmExit).mockRejectedValue(fault);

  try {
    const failure = await runMetroPrepareThroughTimeout(projectRoot);
    assert.equal(failure.cause, fault);
    assert.deepEqual(cleanupDetails(failure), NO_CLEANUP);
  } finally {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  }
});
