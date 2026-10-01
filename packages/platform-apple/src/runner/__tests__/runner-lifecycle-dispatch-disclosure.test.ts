import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createTestRequestCancellation, makeRunnerSession } from './runner-session-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';

// contracts/fixtures/dispatch-disclosure.json, ios-runner pre-send and transport rows: each row
// drives runAppleRunnerCommand through the real lifecycle and restart path with the session start
// mocked; the connect rows run the real connect loop (waitForRunner) over a stubbed fetch and simctl
// curl, and assert the failure the caller receives.

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockInvalidateRunnerSession,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    readRunnerSessionLiveness: vi.fn(() => null),
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

import { runAppleRunnerCommand } from '../runner-client.ts';
import {
  isRetryableRunnerError,
  RUNNER_REPLY_LOST_REASON,
} from '../runner-error-classification.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';
import { waitForRunner } from '../runner-startup-transport.ts';

const requestCancellation = createTestRequestCancellation();

beforeEach(() => {
  mockEnsureRunnerSession.mockReset();
  mockExecuteRunnerCommandWithSession.mockReset();
  mockInvalidateRunnerSession.mockReset();
  resetRunnerRecycleLedgerForTests();
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: vi.fn(),
    isRequestCanceled: requestCancellation.isRequestCanceled,
    getRequestSignal: () => undefined,
  });
});

let fakeRunner: FakeRunnerServer | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  await fakeRunner?.close();
  fakeRunner = undefined;
});

async function tap(): Promise<unknown> {
  return await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 120, y: 240 });
}

const readinessPreflightFailure = (): AppError =>
  new AppError('COMMAND_FAILED', 'Runner readiness refused', {
    runnerReadinessPreflightFailed: true,
  });

/**
 * The first attempt runs the real connect loop against a simulator whose every fetch fails the
 * same way and whose simctl curl fallback exits with `curlExitCode`.
 */
function stubConnectLoopFailure(transport: { fetchFailure: () => Error; curlExitCode: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw transport.fetchFailure();
    }),
  );
  appleRunnerTestHost.update({
    runXcrun: vi.fn(async () => ({
      exitCode: transport.curlExitCode,
      stdout: '',
      stderr: `curl exited ${transport.curlExitCode}`,
    })),
  });
  mockExecuteRunnerCommandWithSession.mockImplementationOnce(
    async (device, session, command) =>
      await waitForRunner(device, session.port, command, undefined, 400),
  );
}

/** A connect loop that fails as `transport` says, then a restart that fails. */
async function connectLoopThenFailedRestart(transport: {
  fetchFailure: () => Error;
  curlExitCode: number;
}): Promise<unknown> {
  stubConnectLoopFailure(transport);
  mockEnsureRunnerSession
    .mockResolvedValueOnce(makeRunnerSession())
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner restart failed'));
  try {
    return await tap();
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.runnerRestartReason, 'runner_connect_failed_before_command_send');
    throw error;
  }
}

/** A fetch deadline, then a simctl curl that timed out after its POST: the command may have run. */
const writtenThenLost = {
  fetchFailure: () => new AppError('COMMAND_FAILED', 'Runner command deadline exceeded'),
  curlExitCode: 28,
};

/**
 * `command` is written and its reply lost on the first runner, the runner restarts, and the
 * restarted runner answers every command with `restartedAnswer`.
 */
async function writtenThenLostThenRestarted(
  command: RunnerCommand,
  restartedAnswer: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  stubConnectLoopFailure(writtenThenLost);
  mockEnsureRunnerSession
    .mockResolvedValueOnce(makeRunnerSession())
    .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
  mockExecuteRunnerCommandWithSession.mockImplementation(restartedAnswer);
  try {
    return await runAppleRunnerCommand(IOS_SIMULATOR, command);
  } finally {
    assert.equal(mockEnsureRunnerSession.mock.calls.length, 2, 'the runner is restarted');
  }
}

function sendsOnRestartedRunner(): number {
  return mockExecuteRunnerCommandWithSession.mock.calls.filter(
    ([, session]) => session.port === 8101,
  ).length;
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'ios-runner.pre-send.session-start-failed': async () => {
    mockEnsureRunnerSession.mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed'),
    );
    return await tap();
  },
  'ios-runner.pre-send.connect-refused-before-write': () =>
    connectLoopThenFailedRestart({
      fetchFailure: () =>
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8100'), {
            code: 'ECONNREFUSED',
          }),
        }),
      curlExitCode: 7,
    }),
  'ios-runner.transport.written-then-lost': async () => {
    const runnerSession =
      await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
    const runner = await startFakeRunnerServer({ tap: [{ kind: 'exit' }] });
    fakeRunner = runner;
    // The status probe finds no listener, over fetch or the simctl curl fallback.
    const { retryWithPolicy } = appleRunnerTestHost.defaults();
    appleRunnerTestHost.update({
      runXcrun: vi.fn(async () => ({ exitCode: 7, stdout: '', stderr: 'curl exited 7' })),
      retryWithPolicy: (task, policy, options) =>
        retryWithPolicy(task, { ...policy, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 }, options),
    });
    mockEnsureRunnerSession.mockResolvedValueOnce(makeRunnerSession({ port: runner.port }));
    mockExecuteRunnerCommandWithSession.mockImplementation(
      runnerSession.executeRunnerCommandWithSession,
    );
    try {
      return await tap();
    } catch (error) {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, RUNNER_REPLY_LOST_REASON);
      assert.equal(error.details?.recovery, 'status_probe_failed');
      assert.equal(error.details?.runnerRestarted, undefined, 'the runner is not restarted');
      throw error;
    } finally {
      assert.equal(runner.requests.filter((entry) => entry.command === 'tap').length, 1);
      assert.deepEqual(
        mockInvalidateRunnerSession.mock.calls[0]?.[1],
        'transport_error_after_command_send',
      );
    }
  },
  'ios-runner.transport.read-only-written-then-lost': async () => {
    try {
      return await writtenThenLostThenRestarted({ command: 'snapshot' }, async () => {
        throw new AppError('COMMAND_FAILED', 'runner resend failed', { dispatched: 'unknown' });
      });
    } finally {
      assert.equal(sendsOnRestartedRunner(), 1, 'the read is sent again');
    }
  },
  'ios-runner.pre-send.readiness-preflight-after-restart': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
    mockExecuteRunnerCommandWithSession
      .mockRejectedValueOnce(readinessPreflightFailure())
      .mockRejectedValueOnce(readinessPreflightFailure());
    return await tap();
  },
  'ios-runner.transport.replay-failed-after-unwritten-first-attempt': async () => {
    mockEnsureRunnerSession
      .mockResolvedValueOnce(makeRunnerSession())
      .mockResolvedValueOnce(makeRunnerSession({ port: 8101 }));
    mockExecuteRunnerCommandWithSession
      .mockRejectedValueOnce(readinessPreflightFailure())
      .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner replay failed'));
    try {
      return await tap();
    } finally {
      assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 2);
    }
  },
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every ios-runner pre-send dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}

test('a mutation whose connect-loop POST timed out after writing is not restarted or resent', async () => {
  stubConnectLoopFailure(writtenThenLost);
  mockEnsureRunnerSession.mockResolvedValueOnce(makeRunnerSession());
  mockExecuteRunnerCommandWithSession.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'status probe failed'),
  );
  await assert.rejects(tap(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.runnerRestarted, undefined);
    assert.equal(error.details?.dispatched, 'unknown');
    assert.equal(error.details?.reason, RUNNER_REPLY_LOST_REASON);
    assert.equal(error.details?.recovery, 'status_probe_failed');
    return true;
  });
  assert.equal(mockEnsureRunnerSession.mock.calls.length, 1, 'the runner is not restarted');
  const taps = mockExecuteRunnerCommandWithSession.mock.calls.filter(
    ([, , command]) => command.command === 'tap',
  );
  assert.equal(taps.length, 1, 'the tap is sent once');
});

test('a mutation whose reply and status probe both fail on transport text is not resent', async () => {
  mockEnsureRunnerSession.mockResolvedValueOnce(makeRunnerSession());
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockRejectedValue(new AppError('COMMAND_FAILED', 'connect ECONNREFUSED 127.0.0.1:8100'));
  await assert.rejects(tap(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, RUNNER_REPLY_LOST_REASON);
    assert.equal(error.details?.transportError, 'fetch failed');
    assert.equal(isRetryableRunnerError(error), false);
    return true;
  });
  const taps = mockExecuteRunnerCommandWithSession.mock.calls.filter(
    ([, , command]) => command.command === 'tap',
  );
  assert.equal(taps.length, 1, 'the tap is sent once');
});

test('a read whose first POST may have been written and whose restart fails discloses unknown', async () => {
  stubConnectLoopFailure(writtenThenLost);
  mockEnsureRunnerSession
    .mockResolvedValueOnce(makeRunnerSession())
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'runner restart failed'));
  await assert.rejects(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerRestartReason, 'runner_connect_failed_before_command_send');
      assert.equal(error.details?.dispatched, 'unknown');
      return true;
    },
  );
});

test('a plain Error before the exchange is normalized and discloses no', async () => {
  mockEnsureRunnerSession.mockRejectedValueOnce(new Error('spawn EACCES'));
  await assert.rejects(tap(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.message, 'spawn EACCES');
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(mockExecuteRunnerCommandWithSession.mock.calls.length, 0);
});
