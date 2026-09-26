import assert from 'node:assert/strict';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import type { ExecResult } from '@agent-device/host-kit/command';
import type { RunnerSession } from '../runner-session.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { withAppleRunnerProvider } from '../runner-provider.ts';
import { classifyRunnerReportedError, type RunnerCommand } from '../runner-contract.ts';
import {
  createRunnerPhaseBudget,
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
} from '../runner-cache-metadata.ts';
import { captureDiagnostics } from './runner-session-fixtures.ts';
import { startFakeRunnerServer, type FakeRunnerServer } from './fake-runner-server.ts';
import { resolveRunnerDetachDecision, RunnerCommandAccounting } from '../runner-session-types.ts';
import { requireLifecycleSettlementRows } from './runner-swift-settlement-fixtures.ts';

/**
 * The wiring regression the recovery suite cannot provide (#1644 review P1):
 * that suite calls `handleRunnerTransportErrorAfterCommandSend` directly, so
 * deleting the shipped callsite in `runner-lifecycle.ts` leaves it green.
 *
 * This enters at `runAppleRunnerCommand` — the production facade and the
 * AppleRunnerProvider seam — and fakes only session CREATION, the xcodebuild
 * spawn no unit test can perform. Real: command-id assignment, provider
 * resolution, `executeRunnerCommand`'s catch/classification, the recovery
 * callsite, the whole recovery module, `executeRunnerCommandWithSession`,
 * the transport fetch, and response parsing. Removing the
 * `isRetryableRunnerError` branch that routes into recovery turns this red
 * (verified by doing exactly that).
 *
 * Entering one layer lower (`executeRunnerCommand`) silently defeats the
 * test: the command id is assigned by the facade, and recovery declines to
 * probe a command without one.
 */

let server: FakeRunnerServer | undefined;

const { ensureRunnerSessionMock, invalidateRunnerSessionMock } = vi.hoisted(() => ({
  ensureRunnerSessionMock: vi.fn(),
  invalidateRunnerSessionMock: vi.fn(async () => {}),
}));

vi.mock('../runner-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-session.ts')>();
  return {
    ...actual,
    // Session creation only. executeRunnerCommandWithSession stays REAL, so
    // the send → classify → recover path under test is production code.
    ensureRunnerSession: ensureRunnerSessionMock,
    invalidateRunnerSession: invalidateRunnerSessionMock,
  };
});

const { runAppleRunnerCommand } = await import('../runner-client.ts');

beforeEach(() => {
  const { retryWithPolicy } = appleRunnerTestHost.defaults();
  appleRunnerTestHost.update({
    retryWithPolicy: (task, policy, options) =>
      retryWithPolicy(task, { ...policy, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 }, options),
  });
});

type LostResponseAcceptanceCommand = 'press' | 'fill';

const LOST_RESPONSE_MUTATION_ROWS = {
  press: {
    acceptanceCommand: 'press',
    runnerCommand: 'tap',
    request: { command: 'tap', x: 5, y: 5 },
  },
  fill: {
    acceptanceCommand: 'fill',
    runnerCommand: 'type',
    request: { command: 'type', text: 'hello', textEntryMode: 'replace' },
  },
} as const satisfies Record<
  LostResponseAcceptanceCommand,
  Readonly<{
    acceptanceCommand: LostResponseAcceptanceCommand;
    runnerCommand: 'tap' | 'type';
    request: Readonly<Record<string, unknown>>;
  }>
>;

afterEach(async () => {
  await server?.close();
  server = undefined;
  ensureRunnerSessionMock.mockReset();
  invalidateRunnerSessionMock.mockReset();
});

function makeRunnerSession(port: number, sessionId = `wiring:${port}`): RunnerSession {
  const session: RunnerSession = {
    sessionId,
    device: IOS_SIMULATOR,
    deviceId: IOS_SIMULATOR.id,
    port,
    xctestrunPath: '/tmp/wiring.xctestrun',
    jsonPath: '/tmp/wiring.json',
    testPromise: new Promise<ExecResult>(() => {}),
    child: { pid: process.pid, exitCode: null },
    state: 'ready',
    commandCharges: new RunnerCommandAccounting(),
  };
  return session;
}

function seedSession(port: number): RunnerSession {
  const session = makeRunnerSession(port);
  ensureRunnerSessionMock.mockResolvedValue(session);
  return session;
}

test.each(Object.values(LOST_RESPONSE_MUTATION_ROWS))(
  'acceptance row: lost-response-after-mutation for $acceptanceCommand does not replay the mutation',
  async ({ runnerCommand, request }) => {
    // 1st request: the mutation, answered by dropping the connection
    // mid-response (the real "lost response" shape). 2nd: the status probe.
    server = await startFakeRunnerServer({
      // The mutation's response is dropped mid-flight (the real "lost
      // response" shape); the status probe then returns the retained one.
      [runnerCommand]: [{ kind: 'hangUp' }],
      status: [
        {
          kind: 'ok',
          data: {
            lifecycleState: 'completed',
            lifecycleResponseJson: JSON.stringify({ ok: true, data: { recovered: true } }),
          },
        },
      ],
    });
    seedSession(server.port);

    const result = await runAppleRunnerCommand(IOS_SIMULATOR, { ...request });

    // The recovered payload proves the whole chain ran: classification said
    // retryable, the callsite invoked recovery, recovery probed status, and
    // the retained response replaced the lost one.
    assert.deepEqual(result, { recovered: true });
    const mutation = server.requests.find((entry) => entry.command === runnerCommand);
    const status = server.requests.find((entry) => entry.command === 'status');
    assert.ok(mutation, `${runnerCommand} reached the runner`);
    assert.ok(status, 'recovery probed status');
    // The probe must reference the exact command id the send assigned.
    assert.equal(typeof mutation.body.commandId, 'string');
    assert.equal(status.body.statusCommandId, mutation.body.commandId);
    assert.equal(
      server.requests.filter((entry) => entry.command === runnerCommand).length,
      1,
      `${runnerCommand} must not be silently replayed after the response is lost`,
    );
  },
);

// #2965: an inline `status` probe answers while the command it probes may still be executing, so its
// own reply must not clear the mutation's outstanding charge. The handoff verdict is asserted through
// `resolveRunnerDetachDecision` — the exact gate `detachRunnerSessionForShutdown` consults. Rows come
// from the runner journal's own state list, so a state the runner gains is a missing row rather than an
// unruled verdict.
const LOST_RESPONSE_HANDOFF_ROWS = requireLifecycleSettlementRows({
  completed: true,
  failed: true,
  accepted: false,
  started: false,
  notAccepted: false,
});

test.each(LOST_RESPONSE_HANDOFF_ROWS)(
  'a lost mutation and status $lifecycleState leaves handoff $settlesCharge',
  async ({ lifecycleState, settlesCharge }) => {
    server = await startFakeRunnerServer({
      tap: [{ kind: 'hangUp' }],
      status: [{ kind: 'ok', data: { lifecycleState } }],
    });
    const session = seedSession(server.port);

    // The mutation is refused, never replayed, whatever the terminal verdict — recovery keeps the
    // session and reports the command's state to the caller.
    await expect(
      runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
    ).rejects.toThrow(AppError);
    assert.equal(
      server.requests.filter((request) => request.command === 'tap').length,
      1,
      'the mutation is sent once',
    );
    // `notAccepted` is the journal's "never seen this id", which this daemon cannot read as a safe
    // terminal state: it keeps the invalidation path and its charge, while every state the journal
    // actually reports for the command keeps the session.
    assert.equal(
      invalidateRunnerSessionMock.mock.calls.length,
      lifecycleState === 'notAccepted' ? 1 : 0,
      `${lifecycleState} must ${lifecycleState === 'notAccepted' ? '' : 'not '}invalidate the session`,
    );
    assert.equal(resolveRunnerDetachDecision(session).detach, settlesCharge);
  },
);

test('a lost mutation answered by an inline status probe keeps handoff refused', async () => {
  // `started` with the runner reporting itself not busy is the legitimate state this issue is about:
  // the probe is served off the XCTest channel while the abandoned mutation keeps running.
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'started', runnerMainThreadBusy: false } }],
  });
  const session = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.equal(session.runnerMainThreadBusy, false);
  assert.deepEqual(resolveRunnerDetachDecision(session), {
    detach: false,
    reason: 'command_in_flight',
  });
});

test('an answered uptime health probe keeps handoff refused over an abandoned mutation', async () => {
  // The other inline probe, and the realistic #2965 producer: `prepareIosRunner` and prewarm send
  // `uptime` as background health traffic while a mutation is still owed. `status` only ever comes
  // from recovery, so pinning it alone would leave `uptime` free to start carrying a charge again —
  // whose answer would then forgive the mutation's residue on the serial-queue premise and hand a
  // runner off mid-mutation.
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'started' } }],
    uptime: [
      { kind: 'ok', data: { uptime: 12 } },
      { kind: 'ok', data: { uptime: 13 } },
    ],
  });
  const session = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  // One charge: the mutation. The readiness preflight's probe is inline and carries no charge, so it
  // cannot arrive here as a second debt that some later answer could pay off (#2965).
  assert.equal(session.commandCharges.outstandingChargeCount, 1);

  await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'uptime' });
  assert.equal(
    server.requests.filter((request) => request.command === 'uptime').length > 1,
    true,
    'this command is a second probe, answered by the same session',
  );
  // The probe answered and owed nothing, so the mutation is still the only thing owed and the runner
  // stays on the kill path rather than being handed off mid-mutation.
  assert.equal(session.commandCharges.outstandingChargeCount, 1);
  assert.equal(session.commandCharges.hasAbandonedCharges, true);
  assert.deepEqual(resolveRunnerDetachDecision(session), {
    detach: false,
    reason: 'command_in_flight',
  });
});

test('terminal status for a lost mutation charges the next lost mutation afresh', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }, { kind: 'hangUp' }],
    status: [
      { kind: 'ok', data: { lifecycleState: 'completed' } },
      { kind: 'ok', data: { lifecycleState: 'started' } },
    ],
  });
  const session = seedSession(server.port);

  const first = await captureDiagnostics(async () => {
    await expect(
      runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
    ).rejects.toThrow(AppError);
  });
  // The daemon log has to say whether terminal evidence actually paid the debt, because a refused
  // settlement and a settled one both leave the runner answering (#2965).
  assert.match(first, /"abandonedChargeSettled":true/);
  assert.equal(resolveRunnerDetachDecision(session).detach, true);

  // The settlement is this command's, not a latch: a second mutation that loses its response is
  // charged again and only its own terminal verdict frees the runner.
  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.equal(resolveRunnerDetachDecision(session).detach, false);
});

test('terminal status with the runner reporting busy still refuses handoff', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'completed', runnerMainThreadBusy: true } }],
  });
  const session = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);

  // The journal verdict discharged the charge, yet the runner's own occupancy report keeps it on the
  // kill path: a terminal state never bypasses the busy gate (#2552).
  assert.equal(session.runnerMainThreadBusy, true);
  assert.deepEqual(resolveRunnerDetachDecision(session), {
    detach: false,
    reason: 'main_thread_occupied',
  });
});

test('a lost mutation whose status probe fails keeps the runner on the kill path', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'hangUp' }],
  });
  const session = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.equal(resolveRunnerDetachDecision(session).detach, false);
});

test('a healthy command after a settled abandoned charge returns the runner to handoff-eligible', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'completed' } }],
    snapshot: [{ kind: 'ok', data: { nodes: [] } }],
  });
  const session = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.equal(resolveRunnerDetachDecision(session).detach, true);

  await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });
  assert.equal(resolveRunnerDetachDecision(session).detach, true);
});

test('a runner that reports the command failed surfaces that failure, not the transport error', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [
      { kind: 'ok', data: { lifecycleState: 'failed', lifecycleErrorMessage: 'tap missed' } },
    ],
  });
  seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(AppError);
  assert.ok(server.requests.some((request) => request.command === 'status'));
});

test('an unrecoverable lifecycle state still reaches recovery and reports the invalidation', async () => {
  server = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'zombie' } }],
  });
  seedSession(server.port);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'tap', x: 5, y: 5 }),
  ).rejects.toThrow(/invalidated the runner session/);
  assert.ok(server.requests.some((request) => request.command === 'status'));
});

test('a failed restart preserves the invalidated runner evidence', async () => {
  const restartedServer = await startFakeRunnerServer({
    tap: [{ kind: 'hangUp' }],
    status: [{ kind: 'ok', data: { lifecycleState: 'zombie' } }],
  });
  try {
    server = await startFakeRunnerServer({
      uptime: [{ kind: 'runnerError', code: 'COMMAND_FAILED', message: 'fetch failed' }],
    });
    const staleSession = makeRunnerSession(server.port, 'session-stale');
    const restartedSession = makeRunnerSession(restartedServer.port, 'session-restarted');
    ensureRunnerSessionMock
      .mockResolvedValueOnce(staleSession)
      .mockResolvedValueOnce(restartedSession);

    await expect(
      runAppleRunnerCommand(
        IOS_SIMULATOR,
        { command: 'tap', x: 5, y: 5 },
        { logPath: '/tmp/restart.ndjson' },
      ),
    ).rejects.toMatchObject({
      details: {
        runnerRestarted: true,
        runnerRestartReason: 'runner_readiness_preflight_failed_before_command_send',
        runnerRestartCommand: 'tap',
        runnerInvalidatedSessionId: staleSession.sessionId,
        runnerRestartSessionId: restartedSession.sessionId,
        logPath: '/tmp/restart.ndjson',
      },
    });
  } finally {
    await restartedServer.close();
  }
});

// A runner that has not answered yet is readiness work, not observation: a caller whose deadline
// lands there needs to know the start consumed it, so the cancellation names the phase (#2343).
test('a cancellation during a runner start names the start as the readiness phase', async () => {
  const unanswered = await startFakeRunnerServer([]);
  await unanswered.close();
  const starting = { ...makeRunnerSession(unanswered.port), state: 'starting' as const };
  ensureRunnerSessionMock.mockResolvedValue(starting);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }, { signal: controller.signal }),
  ).rejects.toMatchObject({
    details: { reason: 'request_canceled', readinessPhase: 'runner-start' },
  });
  expect(invalidateRunnerSessionMock).toHaveBeenCalledWith(
    starting,
    'runner_startup_request_canceled',
  );
});

test('a cancellation before any runner session exists names the start as the readiness phase', async () => {
  ensureRunnerSessionMock.mockImplementation(
    async (_device: unknown, options: { signal?: AbortSignal }) =>
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(createRequestCanceledError()), {
          once: true,
        });
      }),
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  await expect(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }, { signal: controller.signal }),
  ).rejects.toMatchObject({ details: { readinessPhase: 'runner-start' } });
});

test('a cancellation of a command on a ready runner is not readiness work', async () => {
  const silent = http.createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    seedSession((silent.address() as AddressInfo).port);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const command = runAppleRunnerCommand(
      IOS_SIMULATOR,
      { command: 'snapshot' },
      { signal: controller.signal },
    );

    await expect(command).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
    await expect(command).rejects.not.toHaveProperty('details.readinessPhase');
  } finally {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test('an exact-session command never dispatches to a replacement runner', async () => {
  server = await startFakeRunnerServer({ recordStop: [{ kind: 'ok', data: {} }] });
  const replacement = seedSession(server.port);

  await expect(
    runAppleRunnerCommand(
      IOS_SIMULATOR,
      { command: 'recordStop' },
      { expectedRunnerSessionId: `${replacement.sessionId}:replaced` },
    ),
  ).rejects.toThrow('runner session ownership changed');
  assert.deepEqual(server.requests, []);
});

test.each(
  (['accept', 'dismiss'] as const).flatMap((action) =>
    (['accepted', 'started', 'completed'] as const).map((lifecycleState) => ({
      action,
      lifecycleState,
      recovery:
        lifecycleState === 'completed'
          ? 'completed_without_retained_response'
          : 'command_still_in_flight',
    })),
  ),
)(
  'alert $action with lost response and $lifecycleState status is not replayed',
  async ({ action, lifecycleState, recovery }) => {
    server = await startFakeRunnerServer({
      alert: [{ kind: 'hangUp' }, { kind: 'ok', data: { replayed: true } }],
      status: [{ kind: 'ok', data: { lifecycleState } }],
    });
    seedSession(server.port);

    await expect(
      runAppleRunnerCommand(IOS_SIMULATOR, { command: 'alert', action }),
    ).rejects.toMatchObject({ details: { lifecycleState, recovery } });

    const actions = server.requests.filter((request) => request.command === 'alert');
    const probes = server.requests.filter((request) => request.command === 'status');
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.body.action, action);
    assert.equal(probes.length, 1);
    assert.equal(probes[0]?.body.statusCommandId, actions[0]?.body.commandId);
    assert.equal(invalidateRunnerSessionMock.mock.calls.length, 0);
  },
);

test.each([undefined, 'get'] as const)(
  'alert query action %s remains retryable after a transport failure',
  async (action) => {
    server = await startFakeRunnerServer({
      alert: [{ kind: 'hangUp' }, { kind: 'ok', data: { present: true } }],
    });
    seedSession(server.port);

    const result = await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'alert', action });

    assert.deepEqual(result, { present: true });
    const queries = server.requests.filter((request) => request.command === 'alert');
    assert.equal(queries.length, 2);
    assert.equal(queries[0]?.body.commandId, queries[1]?.body.commandId);
  },
);

test.each([undefined, 'get', 'accept', 'dismiss'] as const)(
  'alert action %s selects startup readiness by mutation semantics',
  async (action) => {
    server = await startFakeRunnerServer({ alert: [{ kind: 'ok', data: {} }] });
    seedSession(server.port).state = 'starting';

    await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'alert', action });

    assert.deepEqual(
      server.requests.map((request) => request.command),
      action === 'accept' || action === 'dismiss' ? ['uptime', 'alert'] : ['alert'],
    );
  },
);

test.each([undefined, 'get', 'accept', 'dismiss'] as const)(
  'alert action %s selects provider retries by mutation semantics',
  async (action) => {
    const commands: RunnerCommand[] = [];
    const busy = classifyRunnerReportedError('RUNNER_BUSY');
    const failure = new AppError(busy.code, 'runner busy', busy.details);
    const result = withAppleRunnerProvider(
      async (_device, command) => {
        commands.push(command);
        if (commands.length === 1) throw failure;
        return { present: true };
      },
      { deviceId: IOS_SIMULATOR.id },
      () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'alert', action }),
    );

    if (action === 'accept' || action === 'dismiss') {
      await assert.rejects(result, (error: unknown) => error === failure);
      assert.equal(commands.length, 1);
    } else {
      assert.deepEqual(await result, { present: true });
      assert.equal(commands.length, 2);
      assert.equal(commands[0]?.commandId, commands[1]?.commandId);
    }
  },
);

// The refusal is retriable for the caller's own poll, but to the transport it is a definite runner
// answer: no resend, no lost-response status probe, and no invalidation of a healthy session.
test('a read refused over a not-running app is one definite answer, not a transport retry', async () => {
  server = await startFakeRunnerServer({
    snapshot: [
      { kind: 'runnerError', code: 'APP_NOT_RUNNING', message: "app 'com.example' is not running" },
    ],
  });
  seedSession(server.port);

  await assert.rejects(
    runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.runnerErrorCode, 'APP_NOT_RUNNING');
      assert.equal(error.details?.retriable, true);
      return true;
    },
  );
  assert.deepEqual(
    server.requests.map((request) => request.command).filter((command) => command !== 'uptime'),
    ['snapshot'],
  );
  assert.equal(invalidateRunnerSessionMock.mock.calls.length, 0);
});

test('a read the runner refused as busy is resent on the same session', async () => {
  server = await startFakeRunnerServer({
    snapshot: [
      { kind: 'runnerError', code: 'RUNNER_BUSY', message: 'runner is draining' },
      { kind: 'ok', data: { captured: true } },
    ],
    status: [
      {
        kind: 'ok',
        data: {
          lifecycleState: 'failed',
          lifecycleErrorCode: 'RUNNER_BUSY',
          lifecycleErrorMessage: 'runner is draining',
        },
      },
    ],
  });
  seedSession(server.port);

  assert.deepEqual(await runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' }), {
    captured: true,
  });
  assert.equal(server.requests.filter((request) => request.command === 'snapshot').length, 2);
  assert.equal(invalidateRunnerSessionMock.mock.calls.length, 0);
});

// `retriable` on these tells the caller's next request to try again. Resending inside this request
// would open a fresh startup budget per attempt, or second-guess a provider's own transport policy.
const readSnapshot = () => runAppleRunnerCommand(IOS_SIMULATOR, { command: 'snapshot' });
const sessionStarts = () => ensureRunnerSessionMock.mock.calls.length;

test.each([
  {
    producer: 'a spent startup budget',
    reason: 'runner_phase_budget_exhausted',
    arrange: () => {
      ensureRunnerSessionMock.mockImplementation(async () =>
        requireRunnerPhaseRemainingMs(createRunnerPhaseBudget(0, undefined), 'runner_startup'),
      );
      return { run: readSnapshot, sends: sessionStarts };
    },
  },
  {
    producer: 'an unreadable toolchain',
    reason: 'apple_toolchain_probe_unavailable',
    arrange: () => {
      resetAllProcessMemosForTests();
      appleRunnerTestHost.update({
        runCmdSync: () => ({ exitCode: 1, stdout: '', stderr: 'xcode-select: error' }),
      });
      ensureRunnerSessionMock.mockImplementation(async () =>
        resolveExpectedRunnerCacheMetadata(IOS_SIMULATOR),
      );
      return { run: readSnapshot, sends: sessionStarts };
    },
  },
  {
    producer: 'an external runner provider',
    reason: 'provider_transport_unavailable',
    arrange: () => {
      let calls = 0;
      const provider = async () => {
        calls += 1;
        throw new AppError('COMMAND_FAILED', 'provider transport unavailable', {
          reason: 'provider_transport_unavailable',
          retriable: true,
        });
      };
      return {
        run: () => withAppleRunnerProvider(provider, { deviceId: IOS_SIMULATOR.id }, readSnapshot),
        sends: () => calls,
      };
    },
  },
])('a retriable read failure from $producer is not resent', async ({ reason, arrange }) => {
  const { run, sends } = arrange();

  await assert.rejects(run(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, reason);
    assert.equal(error.details?.retriable, true);
    return true;
  });
  assert.equal(sends(), 1);
});
