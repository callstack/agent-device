import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createTestRequestCancellation, makeRunnerSession } from './runner-session-fixtures.ts';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';

// The read-only resend policy around a `RUNNER_BUSY` refusal. The runner refuses fast while
// watchdog-abandoned XCTest work drains, so the daemon's resend has to outlast that drain, keep
// the old three-attempt budget for transport failures, and stay cancellable across the seconds it
// may now wait.

const {
  mockEnsureRunnerSession,
  mockExecuteRunnerCommandWithSession,
  mockReadRunnerSessionLiveness,
  mockInvalidateRunnerSession,
} = vi.hoisted(() => ({
  mockEnsureRunnerSession: vi.fn(),
  mockExecuteRunnerCommandWithSession: vi.fn(),
  mockReadRunnerSessionLiveness: vi.fn(),
  mockInvalidateRunnerSession: vi.fn(),
}));

vi.mock('../runner-session.ts', async () => {
  const actual =
    await vi.importActual<typeof import('../runner-session.ts')>('../runner-session.ts');
  return {
    ...actual,
    ensureRunnerSession: mockEnsureRunnerSession,
    executeRunnerCommandWithSession: mockExecuteRunnerCommandWithSession,
    readRunnerSessionLiveness: mockReadRunnerSessionLiveness,
    invalidateRunnerSession: mockInvalidateRunnerSession,
  };
});

import { runAppleRunnerCommand } from '../runner-client.ts';
import { buildRunnerResponseError } from '../runner-contract.ts';
import { resetRunnerRecycleLedgerForTests } from '../runner-recycle-ledger.ts';

const requestCancellation = createTestRequestCancellation();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  resetRunnerRecycleLedgerForTests();
  requestCancellation.reset();
  appleRunnerTestHost.update({
    emitDiagnostic: vi.fn(),
    isRequestCanceled: requestCancellation.isRequestCanceled,
    getRequestSignal: () => undefined,
  });
  const session = makeRunnerSession({ state: 'ready' });
  mockEnsureRunnerSession.mockResolvedValue(session);
  // A live session, or `executeRunnerCommand` reads the resend as a recycle boot and charges the
  // per-request recycle budget instead of resending.
  mockReadRunnerSessionLiveness.mockReturnValue({
    sessionId: session.sessionId,
    liveness: 'ready',
  });
});

/** The runner's live refusal, exactly as the transport decodes it. */
function busyRefusal(): AppError {
  return buildRunnerResponseError({
    ok: false,
    error: { code: 'RUNNER_BUSY', message: 'The iOS runner is still finishing a previous command' },
  });
}

function sentCommands(): string[] {
  return mockExecuteRunnerCommandWithSession.mock.calls.map((call) => call[2].command);
}

test('read-only commands wait out RUNNER_BUSY past the transport resend backoff', async () => {
  // Three busy answers spaced 200/400/800ms apart, then the runner answers. The default three
  // attempts stopped after the second delay, before the abandoned work had drained.
  vi.useFakeTimers();
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(busyRefusal())
    .mockRejectedValueOnce(busyRefusal())
    .mockRejectedValueOnce(busyRefusal())
    .mockResolvedValueOnce({ nodes: [], truncated: false });

  const pending = runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });
  await vi.advanceTimersByTimeAsync(6_000);
  const result = await pending;

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
  // A structured refusal already says the command did not run, so no status probe sits between
  // the resends.
  assert.deepEqual(sentCommands(), ['snapshot', 'snapshot', 'snapshot', 'snapshot']);
});

test('a RUNNER_BUSY resend still ends when the refusals outlast the window', async () => {
  vi.useFakeTimers();
  mockExecuteRunnerCommandWithSession.mockImplementation(async () => {
    throw busyRefusal();
  });

  const pending = runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });
  const settled = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(20_000);
  const error = await settled;

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
  assert.equal(error.details?.recovery, undefined, 'the raw refusal reaches the caller unwrapped');
  assert.deepEqual(sentCommands(), Array<string>(8).fill('snapshot'));
});

test('read-only transport failures keep the three-attempt resend budget', async () => {
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockResolvedValueOnce({ nodes: [], truncated: false });

  await assert.rejects(
    () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'fetch failed');
      return true;
    },
  );

  assert.equal(sentCommands().filter((command) => command === 'snapshot').length, 3);
});

test('a cancelled request wakes the RUNNER_BUSY delay instead of sleeping it out', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(busyRefusal())
    .mockResolvedValue({ nodes: [], truncated: false });

  const pending = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { signal: controller.signal },
  );
  const settled = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  // Inside the first 200ms delay; the next attempt would otherwise succeed at the timer.
  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  const error = await settled;

  assert.ok(isRequestCanceledError(error), `expected a canceled request, got ${String(error)}`);
  assert.deepEqual(sentCommands(), ['snapshot']);
});
