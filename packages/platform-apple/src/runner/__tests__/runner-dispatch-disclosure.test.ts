import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { ExecResult } from '@agent-device/host-kit/command';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { handleRunnerTransportErrorAfterCommandSend } from '../runner-command-recovery.ts';
import { isReadOnlyRunnerCommand } from '../runner-command-traits.ts';
import type { RunnerCommand } from '../runner-contract.ts';
import {
  isRetryableRunnerError,
  isStructuredRunnerFailure,
  RUNNER_REPLY_LOST_REASON,
} from '../runner-error-classification.ts';
import { runApplePressSeries } from '../runner-sequence.ts';
import { executeRunnerCommandWithSession, type RunnerSession } from '../runner-session.ts';
import { RunnerCommandAccounting } from '../runner-session-types.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  startFakeRunnerServer,
  type FakeRunnerCommandScript,
  type FakeRunnerResponse,
  type FakeRunnerServer,
} from './fake-runner-server.ts';

// contracts/fixtures/dispatch-disclosure.json, ios-runner rows: each row drives the real send stack
// (executeRunnerCommandWithSession → transport fetch) or the real lost-response recovery against a
// scripted fake runner, or the pre-send validation that refuses before anything is sent, and
// asserts the `details.dispatched` the failure leaves with.

let server: FakeRunnerServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function runnerSession(port: number): RunnerSession {
  return {
    sessionId: `fake:${port}`,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/fake.xctestrun',
    jsonPath: '/tmp/fake.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    state: 'ready',
    commandCharges: new RunnerCommandAccounting(),
  };
}

const TAP: RunnerCommand = { command: 'tap', x: 10, y: 10, commandId: 'cmd-1' };

async function replyFailure(code: string): Promise<unknown> {
  const script: FakeRunnerCommandScript = { tap: [{ kind: 'runnerError', code, message: code }] };
  server = await startFakeRunnerServer(script);
  return await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    runnerSession(server.port),
    TAP,
    undefined,
    5_000,
  );
}

/**
 * The runner hangs up on the command, then answers the status probe with `status`. A read goes
 * through the connect loop, which posts again on each attempt, so the runner hangs up on every
 * attempt until the loop gives up, and the loop's simctl curl fallback times out after its POST.
 * The read's short timeout only bounds how long the loop runs.
 */
async function lostResponse(
  status: FakeRunnerResponse[],
  command: RunnerCommand = TAP,
): Promise<unknown> {
  const readOnly = isReadOnlyRunnerCommand(command);
  server = await startFakeRunnerServer({
    [command.command]: [{ kind: readOnly ? 'hangUpAlways' : 'hangUp' }],
    status,
  });
  if (readOnly) {
    appleRunnerTestHost.update({
      runXcrun: vi.fn(async () => ({ exitCode: 28, stdout: '', stderr: 'curl exited 28' })),
    });
  }
  const session = runnerSession(server.port);
  const transportError = await executeRunnerCommandWithSession(
    IOS_SIMULATOR,
    session,
    command,
    undefined,
    readOnly ? 400 : 5_000,
  ).then(
    () => assert.fail('the fake runner hangs up on the command'),
    (error: unknown) => asAppError(error, 'COMMAND_FAILED'),
  );
  assert.equal(isRetryableRunnerError(transportError), true);
  assert.equal(isStructuredRunnerFailure(transportError), false);
  return await handleRunnerTransportErrorAfterCommandSend({
    device: IOS_SIMULATOR,
    session,
    command,
    transportError,
    options: {},
    signal: undefined,
    invalidationReason: 'transport_error_after_command_send',
    invalidateSession: vi.fn(async () => {}),
  });
}

/** `press --count 25` over the real send stack: chunk one (20 taps) runs, chunk two is refused. */
async function pressSeriesRefusedOnSecondChunk(): Promise<unknown> {
  const firstChunk = Array.from({ length: 20 }, () => ({ ok: true, kind: 'tap' }));
  server = await startFakeRunnerServer({
    sequence: [
      { kind: 'ok', data: { completedSteps: 20, sequenceResults: firstChunk } },
      { kind: 'runnerError', code: 'RUNNER_BUSY', message: 'runner busy' },
    ],
  });
  const session = runnerSession(server.port);
  try {
    return await runApplePressSeries(
      IOS_SIMULATOR,
      { x: 10, y: 20 },
      { button: 'primary', count: 25, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
      undefined,
      async (command) =>
        await executeRunnerCommandWithSession(IOS_SIMULATOR, session, command, undefined, 5_000),
    );
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.dispatchedSteps, 20);
    assert.equal(server.requests.filter((request) => request.command === 'sequence').length, 2);
    throw error;
  }
}

/** `press --count 2` at a non-finite point: validation refuses before any sequence is sent. */
async function pressSeriesWithInvalidStep(): Promise<unknown> {
  const runCommand = vi.fn(async () => ({}));
  try {
    return await runApplePressSeries(
      IOS_SIMULATOR,
      { x: Number.NaN, y: 20 },
      { button: 'primary', count: 2, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
      undefined,
      runCommand,
    );
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'runner_sequence_invalid');
    throw error;
  } finally {
    assert.equal(runCommand.mock.calls.length, 0);
  }
}

function statusReply(data: Record<string, unknown>): FakeRunnerResponse[] {
  return [{ kind: 'ok', data }];
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'ios-runner.reply.INVALID_ARGS': () => replyFailure('INVALID_ARGS'),
  'ios-runner.reply.UNSUPPORTED_OPERATION': () => replyFailure('UNSUPPORTED_OPERATION'),
  'ios-runner.reply.RUNNER_BUSY': () => replyFailure('RUNNER_BUSY'),
  'ios-runner.reply.RUNNER_WEDGED': () => replyFailure('RUNNER_WEDGED'),
  'ios-runner.reply.APP_NOT_RUNNING': () => replyFailure('APP_NOT_RUNNING'),
  'ios-runner.reply.SCROLL_KEYBOARD_OCCLUDES_SURFACE': () =>
    replyFailure('SCROLL_KEYBOARD_OCCLUDES_SURFACE'),
  'ios-runner.reply.ALERT_NOT_FOUND': () => replyFailure('ALERT_NOT_FOUND'),
  'ios-runner.reply.APP_SCREEN_WINDOW_UNRESOLVED': () =>
    replyFailure('APP_SCREEN_WINDOW_UNRESOLVED'),
  'ios-runner.reply.APP_SCREEN_UNRESOLVED': () => replyFailure('APP_SCREEN_UNRESOLVED'),
  'ios-runner.reply.APP_SCREEN_CAPTURE_UNRENDERABLE': () =>
    replyFailure('APP_SCREEN_CAPTURE_UNRENDERABLE'),
  'ios-runner.reply.ELEMENT_NOT_FOUND': () => replyFailure('ELEMENT_NOT_FOUND'),
  'ios-runner.reply.ELEMENT_OFFSCREEN': () => replyFailure('ELEMENT_OFFSCREEN'),
  'ios-runner.reply.AMBIGUOUS_MATCH': () => replyFailure('AMBIGUOUS_MATCH'),
  'ios-runner.reply.MAIN_THREAD_TIMEOUT': () => replyFailure('MAIN_THREAD_TIMEOUT'),
  'ios-runner.reply.unlisted-code': () => replyFailure('XCTEST_RECORDED_FAILURE'),
  'ios-runner.series.later-chunk-refused': pressSeriesRefusedOnSecondChunk,
  'ios-runner.series.invalid-step-before-send': pressSeriesWithInvalidStep,
  'ios-runner.status.failed': () =>
    lostResponse(statusReply({ lifecycleState: 'failed', lifecycleErrorMessage: 'tap failed' })),
  'ios-runner.status.failed-RUNNER_BUSY': () =>
    lostResponse(statusReply({ lifecycleState: 'failed', lifecycleErrorCode: 'RUNNER_BUSY' })),
  'ios-runner.status.completed-without-retained-reply': () =>
    lostResponse(statusReply({ lifecycleState: 'completed' })),
  'ios-runner.status.read-only-completed-without-retained-reply': () =>
    lostResponse(statusReply({ lifecycleState: 'completed' }), {
      command: 'snapshot',
      commandId: 'cmd-1',
    }),
  'ios-runner.status.accepted': () => lostResponse(statusReply({ lifecycleState: 'accepted' })),
  'ios-runner.status.started': () => lostResponse(statusReply({ lifecycleState: 'started' })),
  'ios-runner.status.notAccepted': () =>
    lostResponse(statusReply({ lifecycleState: 'notAccepted' })),
  'ios-runner.status.probe-failed': () =>
    lostResponse([{ kind: 'runnerError', code: 'COMMAND_FAILED', message: 'status failed' }]),
  'ios-runner.status.unavailable': () =>
    lostResponse([], { command: 'tap', x: 10, y: 10 } as RunnerCommand),
};

/** The rows whose mutation's reply stayed lost: each fails as runner_reply_lost and is not resent. */
const REPLY_LOST_ROWS: ReadonlySet<string> = new Set([
  'ios-runner.status.completed-without-retained-reply',
  'ios-runner.status.accepted',
  'ios-runner.status.started',
  'ios-runner.status.notAccepted',
  'ios-runner.status.probe-failed',
  'ios-runner.status.unavailable',
]);

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every ios-runner dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      assert.equal(error.details?.reason === RUNNER_REPLY_LOST_REASON, REPLY_LOST_ROWS.has(row.id));
      return true;
    });
  });
}

const SNAPSHOT: RunnerCommand = { command: 'snapshot', commandId: 'cmd-1' };

test.each([
  ['the status probe fails', [{ kind: 'runnerError', code: 'COMMAND_FAILED', message: 'down' }]],
  ['status answers notAccepted', statusReply({ lifecycleState: 'notAccepted' })],
  ['status answers started', statusReply({ lifecycleState: 'started' })],
  ['status answers completed with no retained reply', statusReply({ lifecycleState: 'completed' })],
] as const)(
  'a read whose reply is lost when %s keeps the transport error it is resent on',
  async (_, status) => {
    await assert.rejects(lostResponse([...status], SNAPSHOT), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.notEqual(error.details?.reason, RUNNER_REPLY_LOST_REASON);
      assert.equal(isRetryableRunnerError(error), true);
      return true;
    });
  },
);
