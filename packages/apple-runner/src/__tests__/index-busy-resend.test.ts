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

import { runAppleRunnerCommand } from '../index.ts';
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
  assert.equal(error.details?.attempts, 8);
  assert.deepEqual(sentCommands(), Array<string>(8).fill('snapshot'));
});

/**
 * Admits `requestId` with a deadline `timeoutMs` from now. The host answers that deadline to a
 * resend loop only when the request itself is read-only, as host-kit's
 * `getRequestReadOnlyDeadlineMs` does for the fact the daemon stamps at admission.
 */
function admitRequest(requestId: string, timeoutMs: number, readOnly: boolean): string {
  const deadlineMs = Date.now() + timeoutMs;
  appleRunnerTestHost.update({
    getRequestReadOnlyDeadlineMs: (id) => (id === requestId && readOnly ? deadlineMs : undefined),
  });
  return requestId;
}

test('under a request deadline, read-only commands outlast the fixed RUNNER_BUSY count', async () => {
  // Twelve busy answers, four past the fixed eight-attempt window, then the runner answers inside
  // the request's 30s deadline.
  vi.useFakeTimers();
  for (let refusal = 0; refusal < 12; refusal += 1) {
    mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(busyRefusal());
  }
  mockExecuteRunnerCommandWithSession.mockResolvedValueOnce({ nodes: [], truncated: false });

  const pending = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: admitRequest('req-deadline-recovers', 30_000, true) },
  );
  await vi.advanceTimersByTimeAsync(20_000);

  assert.deepEqual(await pending, { nodes: [], truncated: false });
  assert.deepEqual(sentCommands(), Array<string>(13).fill('snapshot'));
});

test('a request deadline reached mid-outage ends with the RUNNER_BUSY refusal and its attempt count', async () => {
  vi.useFakeTimers();
  const sentAt: number[] = [];
  mockExecuteRunnerCommandWithSession.mockImplementation(async () => {
    sentAt.push(Date.now());
    throw busyRefusal();
  });
  const startedAt = Date.now();

  const settled = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: admitRequest('req-deadline-outage', 10_000, true) },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const error = await settled;

  assert.ok(error instanceof AppError, `expected the refusal, got ${String(error)}`);
  assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
  // The busy window is 8s (10s less the 2s reserve). Delays of 200, 400, 800, then 1000ms put the
  // tenth send at 7.4s, inside it, and the eleventh at 8.4s, past it: that refusal is the answer.
  assert.equal(error.details?.attempts, 11);
  assert.equal(sentCommands().length, 11);
  assert.equal(sentAt.at(-1)! - startedAt, 8_400);
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

test('a RUNNER_BUSY refusal after the busy window closed is not resent', async () => {
  // A 1s request deadline is inside the 2s reserve, so the window is already closed.
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(busyRefusal())
    .mockResolvedValue({ nodes: [], truncated: false });

  await assert.rejects(
    () =>
      runAppleRunnerCommand(
        IOS_SIMULATOR,
        { command: 'snapshot' },
        { requestId: admitRequest('req-deadline-window-closed', 1_000, true) },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
      assert.equal(error.details?.dispatched, 'no');
      assert.equal(error.details?.attempts, 1);
      return true;
    },
  );
  assert.deepEqual(sentCommands(), ['snapshot']);
});

test('under a request deadline too close for a busy resend, transport failures keep their three attempts', async () => {
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'fetch failed'))
    .mockResolvedValueOnce({ lifecycleState: 'started' })
    .mockResolvedValueOnce({ nodes: [], truncated: false });

  const result = await runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: admitRequest('req-deadline-transport', 1_000, true) },
  );

  assert.deepEqual(result, { nodes: [], truncated: false });
  assert.equal(sentCommands().filter((command) => command === 'snapshot').length, 3);
});

test('a wait deadline landing mid-window rethrows the last RUNNER_BUSY refusal, not a cancel', async () => {
  // `wait` bounds each poll with its own abort signal (runWithinWaitDeadline) and keeps the last
  // typed refusal as the wait's cause. The refusal must therefore survive the deadline: a bare
  // cancellation would make the wait report a stalled capture and drop the runner's own code.
  vi.useFakeTimers();
  const deadline = new AbortController();
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(busyRefusal())
    .mockResolvedValue({ nodes: [], truncated: false });

  const pending = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: 'req-wait', signal: deadline.signal },
  );
  const settled = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(50);
  deadline.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  await vi.advanceTimersByTimeAsync(0);
  const error = await settled;

  assert.ok(error instanceof AppError, `expected the refusal, got ${String(error)}`);
  assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
  assert.equal(error.details?.retriable, true);
  assert.deepEqual(sentCommands(), ['snapshot']);
});

test('a wait deadline landing mid-fetch during a resend still rethrows the RUNNER_BUSY refusal', async () => {
  vi.useFakeTimers();
  const deadline = new AbortController();
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(busyRefusal()).mockImplementationOnce(
    (_device, _session, _command, _logPath, _timeoutMs, signal: AbortSignal | undefined) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );

  const pending = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: 'req-wait-mid-fetch', signal: deadline.signal },
  );
  const settled = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  // Past the first 200ms delay: the second send is in flight when the deadline lands.
  await vi.advanceTimersByTimeAsync(250);
  deadline.abort(new DOMException('Wait deadline exceeded', 'TimeoutError'));
  await vi.advanceTimersByTimeAsync(0);
  const error = await settled;

  assert.ok(error instanceof AppError, `expected the refusal, got ${String(error)}`);
  assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
  assert.deepEqual(sentCommands(), ['snapshot', 'snapshot']);
});

test('a cancelled request wakes the RUNNER_BUSY delay and reports the cancellation', async () => {
  vi.useFakeTimers();
  const request = new AbortController();
  appleRunnerTestHost.update({ getRequestSignal: () => request.signal });
  mockExecuteRunnerCommandWithSession
    .mockRejectedValueOnce(busyRefusal())
    .mockResolvedValue({ nodes: [], truncated: false });

  const pending = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'snapshot' },
    { requestId: 'req-cancelled' },
  );
  const settled = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  // Inside the first 200ms delay; the next attempt would otherwise succeed at the timer.
  await vi.advanceTimersByTimeAsync(50);
  requestCancellation.markRequestCanceled('req-cancelled');
  request.abort();
  await vi.advanceTimersByTimeAsync(0);
  const error = await settled;

  assert.ok(isRequestCanceledError(error), `expected a canceled request, got ${String(error)}`);
  assert.deepEqual(sentCommands(), ['snapshot']);
});

test('a mutating command meets RUNNER_BUSY once, with no status probe and no resend', async () => {
  // The status-recovery bypass for structured replies reaches mutating commands too: the refusal
  // says the tap did not run, so there is nothing to recover and nothing is replayed, even with a
  // request deadline that would let a read resend.
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(busyRefusal());

  await assert.rejects(
    () =>
      runAppleRunnerCommand(
        IOS_SIMULATOR,
        { command: 'tap', x: 120, y: 240 },
        { requestId: admitRequest('req-tap-read-only-window', 30_000, true) },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
      assert.equal(error.details?.recovery, undefined);
      return true;
    },
  );

  assert.deepEqual(sentCommands(), ['tap']);
  assert.equal(mockInvalidateRunnerSession.mock.calls.length, 0);
});

// The viewport read before a swipe runs under the swipe's request. That budget belongs to the swipe
// dispatched after it, so a busy drain keeps the fixed window and refuses fast with nothing sent.
test('a busy read inside a mutating request keeps the fixed window under a 30s deadline', async () => {
  vi.useFakeTimers();
  mockExecuteRunnerCommandWithSession.mockImplementation(async () => {
    throw busyRefusal();
  });

  const settled = runAppleRunnerCommand(
    IOS_SIMULATOR,
    { command: 'gestureViewport', appBundleId: 'com.example.app' },
    { requestId: admitRequest('req-swipe', 30_000, false) },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await settled;

  assert.ok(error instanceof AppError, `expected the refusal, got ${String(error)}`);
  assert.equal(error.details?.runnerErrorCode, 'RUNNER_BUSY');
  assert.equal(error.details?.dispatched, 'no');
  assert.equal(error.details?.attempts, 8);
  assert.deepEqual(sentCommands(), Array<string>(8).fill('gestureViewport'));
});

test('a read-only alert get answered ALERT_UNRESOLVED is sent once and reported as itself', async () => {
  // A structured reply proves the runner answered, so the read resend reserved for RUNNER_BUSY and
  // transport failures must not spend it: the prompt it saw is reported, never retried as absence.
  mockExecuteRunnerCommandWithSession.mockRejectedValueOnce(
    buildRunnerResponseError({
      ok: false,
      error: { code: 'ALERT_UNRESOLVED', message: 'a system prompt is visible' },
    }),
  );

  await assert.rejects(
    () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'alert', action: 'get' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'ALERT_UNRESOLVED');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );

  assert.deepEqual(sentCommands(), ['alert']);
});
