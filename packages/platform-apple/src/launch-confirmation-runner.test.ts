import assert from 'node:assert/strict';
import { DEFAULT_ALERT_TIMEOUT_MS } from '@agent-device/contracts/alert-contract';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  bindAppleRunnerHost,
  withAppleRunnerProvider,
  type AppleRunnerProvider,
  type RunnerCommand,
} from '@agent-device/apple-runner';
import { appleRunnerHost } from './core/runner-host.ts';

/**
 * The launch-confirmation answer over the real Apple alert legs and the real runner client: command
 * ids and the read-only `RUNNER_BUSY` resend run in the runner client, and only the transport below
 * the runner provider is scripted. A controlled clock charges the abandoned press its watchdog and
 * each busy resend its production backoff, so the re-press gate sees the time the real route would
 * have spent.
 */

const clock = vi.hoisted(() => ({ offsetMs: 0, acceptsSent: 0 }));
const { emitDiagnosticMock } = vi.hoisted(() => ({ emitDiagnosticMock: vi.fn() }));

// The alert legs reach the runner through the package's composition root; route it to the runner
// client under test, whose host this suite binds with a controlled clock.
vi.mock('./core/runner-client.ts', async () => {
  const runnerClient = await import('@agent-device/apple-runner');
  return { runAppleRunnerCommand: runnerClient.runAppleRunnerCommand };
});

vi.mock('./core/app-resolution.ts', () => ({
  resolveIosSimulatorDeepLinkBundleId: vi.fn(async () => 'com.example.app'),
}));

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>();
  emitDiagnosticMock.mockImplementation(actual.emitDiagnostic);
  return { ...actual, emitDiagnostic: emitDiagnosticMock };
});

// Each resend is charged its production backoff on the controlled clock, then waits 1 ms.
bindAppleRunnerHost({
  ...appleRunnerHost,
  retryWithPolicy: (task, policy, options) => {
    let attempt = 0;
    return appleRunnerHost.retryWithPolicy(
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

const { actOnAppleAlert, awaitAppleAlert, readAppleAlert } = await import('./alert.ts');
const { answerSimulatorLaunchConfirmation } = await import('./launch-confirmation.ts');

const NOW_MS = 1_000_000;
/** What the daemon gives a default `open`: its 90 s client envelope less the 30 s result margin. */
const OPEN_DEADLINE_MS = 60_000;
const CONFIRMATION = { message: 'Open in “Example App”?', items: ['Cancel', 'Open'] };

type ScriptedAnswer =
  | Readonly<{ kind: 'ok'; data: Record<string, unknown> }>
  | Readonly<{ kind: 'runnerError'; code: string; message: string }>;

let sentAlerts: RunnerCommand[] = [];

beforeEach(() => {
  clock.offsetMs = 0;
  clock.acceptsSent = 0;
  sentAlerts = [];
  vi.spyOn(Date, 'now').mockImplementation(() => NOW_MS + clock.offsetMs);
});

afterEach(() => {
  vi.restoreAllMocks();
  emitDiagnosticMock.mockClear();
});

/** A runner whose alert answers are scripted; every other command is answered with an empty result. */
function scriptedRunner(alerts: readonly ScriptedAnswer[]): AppleRunnerProvider {
  const queue = [...alerts];
  return {
    hasLiveSession: () => true,
    runCommand: async (_device, command) => {
      if (command.command !== 'alert') return {};
      sentAlerts.push(command);
      // The first press is the one the runner watchdog abandons: it spends the whole watchdog.
      if (command.action === 'accept' && clock.acceptsSent++ === 0) {
        clock.offsetMs += DEFAULT_ALERT_TIMEOUT_MS;
      }
      const answer = queue.shift();
      if (answer === undefined) throw new Error('the scripted runner has no answer left');
      if (answer.kind === 'ok') return answer.data;
      throw new AppError('COMMAND_FAILED', answer.message, { runnerErrorCode: answer.code });
    },
  };
}

async function answer(runner: AppleRunnerProvider, deadlineAtMs: number) {
  const interactor = {
    awaitAlert: async (options) => await awaitAppleAlert(IOS_SIMULATOR, {}, options, {}),
    readAlert: async (options) => await readAppleAlert(IOS_SIMULATOR, {}, options, {}),
    acceptAlert: async (options) => await actOnAppleAlert(IOS_SIMULATOR, {}, 'accept', options, {}),
  } satisfies Pick<Interactor, 'awaitAlert' | 'readAlert' | 'acceptAlert'>;
  return await withAppleRunnerProvider(runner, { deviceId: IOS_SIMULATOR.id }, async () => {
    return await answerSimulatorLaunchConfirmation(
      IOS_SIMULATOR,
      { url: 'example://automation', appBundleId: 'com.example.app' },
      Promise.resolve(interactor as Interactor),
      new AbortController().signal,
      deadlineAtMs,
    );
  });
}

test('an abandoned press is verified through RUNNER_BUSY resends and pressed again within the open deadline', async () => {
  const runner = scriptedRunner([
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
  ]);

  assert.deepEqual(await answer(runner, NOW_MS + OPEN_DEADLINE_MS), { outcome: 'accepted' });
  assert.deepEqual(
    sentAlerts.map((command) => command.action),
    ['get', 'accept', 'get', 'get', 'get', 'accept'],
  );
  const reaccept = emitDiagnosticMock.mock.calls
    .map(([event]) => event)
    .find((event) => event.phase === 'ios_launch_confirmation_reaccept');
  // The watchdog (10 s) and two busy resends (200 ms + 400 ms) leave 49.4 s, well over the 22 s a
  // whole press and its read can cost.
  assert.equal(reaccept?.data?.remainingMs, OPEN_DEADLINE_MS - DEFAULT_ALERT_TIMEOUT_MS - 600);
});

test('a first press is sent with its full watchdog even with only 5 s of the open left', async () => {
  const runner = scriptedRunner([
    { kind: 'ok', data: CONFIRMATION },
    { kind: 'ok', data: {} },
  ]);

  assert.deepEqual(await answer(runner, NOW_MS + 5_000), { outcome: 'accepted' });
  const accept = sentAlerts.find((command) => command.action === 'accept');
  assert.equal(accept?.timeoutMs, DEFAULT_ALERT_TIMEOUT_MS);
});
