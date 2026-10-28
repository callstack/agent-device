import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-device/host-kit/command';
import { DEFAULT_ALERT_TIMEOUT_MS } from '@agent-device/contracts/alert-contract';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import type { RunnerSession } from '../runner-session.ts';
import { RunnerCommandAccounting } from '../runner-session-types.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';

/**
 * The launch-confirmation answer over the real Apple alert legs and the real runner client: command
 * ids, readiness preflights, the read-only `RUNNER_BUSY` resend and the transport all run against a
 * fake runner. Only session creation and the URL-owner lookup are faked. A controlled clock charges
 * the abandoned press its watchdog and each busy resend its production backoff, so the re-press gate
 * sees the time the real route would have spent.
 */

const clock = vi.hoisted(() => ({ offsetMs: 0, acceptsSent: 0 }));
const { ensureRunnerSessionMock, readRunnerSessionLivenessMock, emitDiagnosticMock } = vi.hoisted(
  () => ({
    ensureRunnerSessionMock: vi.fn(),
    readRunnerSessionLivenessMock: vi.fn(),
    emitDiagnosticMock: vi.fn(),
  }),
);

vi.mock('../runner-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-session.ts')>();
  return {
    ...actual,
    ensureRunnerSession: ensureRunnerSessionMock,
    readRunnerSessionLiveness: readRunnerSessionLivenessMock,
  };
});

vi.mock('../runner-transport.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-transport.ts')>();
  return {
    ...actual,
    sendRunnerCommandOnce: async (...args: Parameters<typeof actual.sendRunnerCommandOnce>) => {
      const response = await actual.sendRunnerCommandOnce(...args);
      const command = args[2];
      // The first press is the one the runner watchdog abandons: it spends the whole watchdog.
      if (command.command === 'alert' && command.action === 'accept' && clock.acceptsSent++ === 0) {
        clock.offsetMs += DEFAULT_ALERT_TIMEOUT_MS;
      }
      return response;
    },
  };
});

// The alert legs reach the runner through the package's composition root; route it to the runner
// client under test, which this suite's host setup binds.
vi.mock('../../core/runner-client.ts', async () => {
  const runnerClient = await import('../runner-client.ts');
  return { runAppleRunnerCommand: runnerClient.runAppleRunnerCommand };
});

vi.mock('../../core/app-resolution.ts', () => ({
  resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => 'com.example.app'),
}));

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  emitDiagnosticMock.mockImplementation(actual.emitDiagnostic);
  return { ...actual, emitDiagnostic: emitDiagnosticMock };
});

const { actOnAppleAlert, awaitAppleAlert, readAppleAlert } = await import('../../alert.ts');
const { answerSimulatorLaunchConfirmation } = await import('../../launch-confirmation.ts');

const NOW_MS = 1_000_000;
/** What the daemon gives a default `open`: its 90 s client envelope less the 30 s result margin. */
const OPEN_DEADLINE_MS = 60_000;
const CONFIRMATION = { message: 'Open in “Example App”?', items: ['Cancel', 'Open'] };
let server: FakeRunnerServer | undefined;

beforeEach(() => {
  clock.offsetMs = 0;
  clock.acceptsSent = 0;
  resetRunnerRecycleLedgerForTests();
  vi.spyOn(Date, 'now').mockImplementation(() => NOW_MS + clock.offsetMs);
  const { retryWithPolicy } = appleRunnerTestHost.defaults();
  appleRunnerTestHost.update({
    // Each resend is charged its production backoff on the controlled clock, then waits 1 ms.
    retryWithPolicy: (task, policy, options) => {
      let attempt = 0;
      return retryWithPolicy(
        async (context) => {
          if (attempt > 0) {
            const baseDelayMs = policy?.baseDelayMs ?? 0;
            clock.offsetMs += Math.min(
              baseDelayMs * 2 ** (attempt - 1),
              policy?.maxDelayMs ?? Infinity,
            );
          }
          attempt += 1;
          return await task(context);
        },
        { ...policy, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        options,
      );
    },
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  emitDiagnosticMock.mockClear();
  ensureRunnerSessionMock.mockReset();
  readRunnerSessionLivenessMock.mockReset();
  await server?.close();
  server = undefined;
});

function seedSession(port: number): void {
  const session: RunnerSession = {
    sessionId: `launch-confirmation:${port}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    endpoint: { port, token: 'runner-token-fixture' },
    xctestrunPath: '/tmp/launch-confirmation.xctestrun',
    jsonPath: '/tmp/launch-confirmation.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    state: 'ready',
    commandCharges: new RunnerCommandAccounting(),
  };
  ensureRunnerSessionMock.mockResolvedValue(session);
  // A live session, or a resend reads as a recycle boot and charges the request's recycle budget.
  readRunnerSessionLivenessMock.mockReturnValue({
    sessionId: session.sessionId,
    liveness: 'ready',
  });
}

async function answer(deadlineAtMs: number) {
  const interactor = {
    awaitAlert: async (options) => await awaitAppleAlert(IOS_SIMULATOR, {}, options, {}),
    readAlert: async (options) => await readAppleAlert(IOS_SIMULATOR, {}, options, {}),
    acceptAlert: async (options) => await actOnAppleAlert(IOS_SIMULATOR, {}, 'accept', options, {}),
  } satisfies Pick<Interactor, 'awaitAlert' | 'readAlert' | 'acceptAlert'>;
  return await answerSimulatorLaunchConfirmation(
    IOS_SIMULATOR,
    { url: 'example://automation', appBundleId: 'com.example.app' },
    Promise.resolve(interactor as Interactor),
    new AbortController().signal,
    deadlineAtMs,
  );
}

function sentAlertActions(): unknown[] {
  return (server?.requests ?? [])
    .filter(({ command }) => command === 'alert')
    .map(({ body }) => body.action);
}

test('an abandoned press is verified through RUNNER_BUSY resends and pressed again within the open deadline', async () => {
  server = await startFakeRunnerServer({
    alert: [
      { kind: 'ok', data: CONFIRMATION },
      {
        kind: 'runnerError',
        code: 'MAIN_THREAD_TIMEOUT',
        message: 'main thread execution timed out',
      },
      { kind: 'runnerError', code: 'RUNNER_BUSY', message: 'runner busy' },
      { kind: 'runnerError', code: 'RUNNER_BUSY', message: 'runner busy' },
      { kind: 'ok', data: CONFIRMATION },
      { kind: 'ok', data: {} },
    ],
  });
  seedSession(server.port);

  assert.deepEqual(await answer(NOW_MS + OPEN_DEADLINE_MS), { outcome: 'accepted' });
  assert.deepEqual(sentAlertActions(), ['get', 'accept', 'get', 'get', 'get', 'accept']);
  const reaccept = emitDiagnosticMock.mock.calls
    .map(([event]) => event)
    .find((event) => event.phase === 'ios_launch_confirmation_reaccept');
  // The watchdog (10 s) and two busy resends (200 ms + 400 ms) leave 49.4 s, well over the 22 s a
  // whole press and its read can cost.
  assert.equal(reaccept?.data?.remainingMs, OPEN_DEADLINE_MS - DEFAULT_ALERT_TIMEOUT_MS - 600);
});

test('a first press is sent with its full watchdog even with only 5 s of the open left', async () => {
  server = await startFakeRunnerServer({
    alert: [
      { kind: 'ok', data: CONFIRMATION },
      { kind: 'ok', data: {} },
    ],
  });
  seedSession(server.port);

  assert.deepEqual(await answer(NOW_MS + 5_000), { outcome: 'accepted' });
  const accept = server.requests.find(({ body }) => body.action === 'accept');
  assert.equal(accept?.body.timeoutMs, DEFAULT_ALERT_TIMEOUT_MS);
});
