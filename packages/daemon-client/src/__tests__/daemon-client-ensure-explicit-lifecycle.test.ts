import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { DAEMON_TEARDOWN_GRACE_MS } from '@agent-device/daemon-contracts/daemon-process';
import { DAEMON_QUIESCE_COMMAND } from '@agent-device/daemon-contracts/daemon-resolution';
import { inspectProcessLock, type ProcessLockInspection } from '@agent-device/host-kit/file';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import {
  finishRegisteredDaemonFixtures,
  spawnRegisteredDaemonFixture,
  planRegisteredDaemonLaunches,
  waitForRegisteredDaemonFixture,
} from './registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';
import {
  busy,
  createDaemonLeaver,
  draining,
  failureOf,
  identityIn,
  launchesFreshDaemonAt as launchSeamAnswersAt,
  okResult,
  registerDaemon,
  startScriptedDaemon,
  startScriptedSocketDaemon,
  stateDirAndPaths,
} from './explicit-lifecycle-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => {}),
}));
// Reading the registration judges its lock owner, and one judgement runs one process-table snapshot.
// A contention budget judges a registration these cases keep alive and unchanged, so its inspection is
// read once from the real host and replayed for the rest of the loop. The seam answers only that one
// lock path, and `afterEach` clears it.
let recordedRegistrationLock:
  | { readonly lockPath: string; readonly inspection: ProcessLockInspection }
  | undefined;
vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return {
    ...actual,
    inspectProcessLock: (lockPath: string) =>
      recordedRegistrationLock?.lockPath === lockPath
        ? recordedRegistrationLock.inspection
        : actual.inspectProcessLock(lockPath),
  };
});
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { settleWithin } from '@agent-device/host-kit/settle-within';
import * as transport from '../daemon-client-transport.ts';
import * as daemonClient from '../index.ts';
import * as daemonEnsure from '../daemon-client-ensure.ts';

// The explicit lifecycle: what an attach client may never do, and what `ensureDaemon` may do only
// through the daemon's own answer. Daemons here are loopback stand-ins registered by real children,
// so a kill or a spawn is observable as a dead pid or a call to the launch seam.

const spawn = vi.mocked(runCmdDetachedMonitored);
const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
// `JUDGE_AGAIN_DELAY_MS` in `daemon-client-ensure.ts`.
const JUDGE_AGAIN_DELAY_MS = 250;
// Held before any test replaces `performance.now`, so a moved clock still starts from real elapsed time.
const realNow = performance.now.bind(performance);

// Vitest never cancels a test body: a case that runs long keeps driving its client call while the
// next case is already running, and that call then spends the next case's launch plan and records
// its spawns against it. Every client call is registered here, and `afterEach` joins the ones that
// outlived their case before it resets the shared seams or tears the fixtures down.
const inFlightClientCalls = new Set<Promise<unknown>>();
// Long enough for a real quiesce, drain and start to finish on a loaded runner, and short enough
// that vitest's own hook timeout never reports the leak instead of this file's report.
const JOIN_OUTLIVED_CALLS_MS = 5_000;

function trackedClientCall<A extends readonly unknown[], R>(
  start: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return (...args: A) => {
    const call = start(...args);
    inFlightClientCalls.add(call);
    const settled = () => {
      inFlightClientCalls.delete(call);
    };
    void call.then(settled, settled);
    return call;
  };
}

const sendToDaemon = trackedClientCall(daemonClient.sendToDaemon);
const ensureDaemon = trackedClientCall(daemonEnsure.ensureDaemon);

/**
 * Waits for the client calls that outlived their case, so every launch they make is spent on the
 * seams of the case that started them and never on the next one. A client call cannot be cancelled,
 * so this is bounded: a call that outlasts the join is reported once, by the case that owns it, and
 * dropped. Dropping it means its remaining launches still land on the next case, which is why the
 * join bound is a last resort and not the mechanism the file relies on — a case is expected to leave
 * nothing for the join to wait out.
 */
async function joinOutlivedClientCalls(): Promise<void> {
  const deadline = Date.now() + JOIN_OUTLIVED_CALLS_MS;
  while (inFlightClientCalls.size > 0) {
    const pending = [...inFlightClientCalls];
    const joined = await settleWithin(
      () => Promise.allSettled(pending).then(() => undefined),
      Math.max(0, deadline - Date.now()),
    );
    if (joined.kind === 'settled') continue;
    for (const call of pending) inFlightClientCalls.delete(call);
    assert.fail(
      `${pending.length} client call(s) outlived their case and did not settle within ${JOIN_OUTLIVED_CALLS_MS}ms; leaving them running hands their daemon launches to the next case`,
    );
  }
}

afterEach(async () => {
  // Every reset runs even when the join reports a call that never settled. Skipping one reset is
  // exactly the half-reset state that let one slow case fail the case after it.
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(joinOutlivedClientCalls);
  await attempt(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    spawn.mockReset();
    vi.mocked(sleep).mockReset();
    vi.mocked(sleep).mockImplementation(async () => {});
    recordedRegistrationLock = undefined;
    await finishRegisteredDaemonFixtures();
  });
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'teardown reported more than one problem');
});

/**
 * Leaves the lock inspection of this registration at what the host really says right now. A daemon
 * that keeps changing under `ensureDaemon` is judged once per attempt and one judgement runs one
 * process-table snapshot, so the whole budget is snapshots of a registration these cases keep alive
 * and unchanged. The first snapshot is the host's own answer, taken here.
 */
function registrationLockStaysAsRecorded(
  paths: ReturnType<typeof stateDirAndPaths>['paths'],
): void {
  const inspection = inspectProcessLock(paths.lockPath);
  if (inspection.state !== 'held')
    assert.fail(
      `the registered daemon must hold its own registration lock, saw "${inspection.state}"`,
    );
  recordedRegistrationLock = { lockPath: paths.lockPath, inspection };
}

/**
 * The budget clock, moved by this file: every wait advances it by `stepMs` while the loop keeps asking
 * for its own delay, so the teardown grace passes in a few judgements instead of the hundreds it costs
 * at the real cadence. The loop reads `performance.now()`, the clock this package budgets on, and it is
 * a per-test spy rather than `Date.now`: lock-guard ages are judged off real file mtimes and `Date.now`
 * in the same window.
 */
function judgeAgainBudgetOnMovedClock(stepMs: number): { waitedMs(): number } {
  const startedAtMs = realNow();
  let waitedMs = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => startedAtMs + waitedMs);
  vi.mocked(sleep).mockImplementation(async () => {
    waitedMs += stepMs;
  });
  return { waitedMs: () => waitedMs };
}

/**
 * The budget, through the clock it counts: every wait is asked for at the production cadence, and the
 * loop stopped once that cadence had covered the teardown grace on the clock it reads — one fewer wait
 * falls short of it. Halving the grace or the cadence stops the loop earlier and fails this.
 */
function assertJudgedAgainForTheFullBudget(clock: { waitedMs(): number }, stepMs: number): void {
  const waits = vi.mocked(sleep).mock.calls.map(([ms]) => Number(ms));
  assert.ok(waits.length > 0, 'a contended ensure judged again at least once');
  assert.deepEqual(
    [...new Set(waits)],
    [JUDGE_AGAIN_DELAY_MS],
    'every attempt judged again after one production wait, whatever the clock says since',
  );
  const { waitedMs } = clock;
  assert.ok(
    waitedMs() >= DAEMON_TEARDOWN_GRACE_MS && waitedMs() - stepMs < DAEMON_TEARDOWN_GRACE_MS,
    `${waits.length} judge-again waits must just cover the ${DAEMON_TEARDOWN_GRACE_MS}ms teardown grace (${waitedMs()}ms)`,
  );
  assert.ok(
    waits.length < Math.ceil(DAEMON_TEARDOWN_GRACE_MS / JUDGE_AGAIN_DELAY_MS),
    `the clock, not the wait ceiling, ended the loop: ${waits.length} waits`,
  );
}

/** Real waits, so a start can poll the child it launched. */
function launchesFreshDaemonAt(
  paths: ReturnType<typeof stateDirAndPaths>['paths'],
  httpPort: number,
): void {
  vi.mocked(sleep).mockImplementation(actualRetry.sleep);
  launchSeamAnswersAt(spawn, paths, httpPort);
}

function request(stateDir: string, extra: Record<string, unknown> = {}) {
  return {
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { stateDir, daemonTransport: 'http' as const, ...extra },
    meta: { requestId: 'req-explicit-lifecycle' },
  };
}

async function withLoopback(t: { skip: (note: string) => void }): Promise<boolean> {
  return !(await skipWhenLoopbackUnavailable(t));
}

test('attach reports a missing daemon without starting one', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();

  const error = await failureOf(sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }));

  assert.equal(error.details?.reason, 'daemon-not-running');
  assert.match(String(error.details?.hint), /agent-device devices --state-dir /);
  assert.equal(spawn.mock.calls.length, 0);
  assert.equal(fs.existsSync(paths.infoPath), false);
});

test('attach reports an incompatible daemon with both identities and leaves it running', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(okResult({ via: 'stale' }));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });

  try {
    const error = await failureOf(sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }));

    assert.equal(error.details?.reason, 'daemon-incompatible');
    assert.equal(identityIn(error, 'daemon').version, '0.0.0-stale');
    assert.equal(identityIn(error, 'client').version, readVersion());
    assert.match(String(error.details?.hint), /agent-device daemon stop/);
    assert.equal(isProcessAlive(child.pid), true, 'attach never kills the daemon');
    assert.equal(fs.existsSync(paths.infoPath), true);
    assert.equal(spawn.mock.calls.length, 0);
    assert.deepEqual(stale.rpcCommands, [], 'attach never asks the daemon to leave either');
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

for (const ownership of ['detached', 'embedded'] as const)
  test(`attach leaves an unreachable ${ownership} daemon and names its owner recovery`, async (t) => {
    if (!(await withLoopback(t))) return;
    const { stateDir, paths } = stateDirAndPaths();
    const closed = await startScriptedDaemon(okResult({}));
    await closeLoopbackServer(closed.server);
    const { child } = await registerDaemon(paths, { httpPort: closed.port, ownership });

    const error = await failureOf(sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }));

    assert.equal(error.details?.reason, 'daemon-not-running');
    assert.equal(identityIn(error, 'daemon').pid, child.pid);
    assert.match(
      String(error.details?.hint),
      ownership === 'embedded'
        ? /owned by host process \d+\. Close it there/
        : /agent-device daemon stop/,
    );
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  });

test('attach uses a compatible daemon and never lets a timeout retire it', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const live = await startScriptedDaemon(okResult({ via: 'live' }));
  await registerDaemon(paths, { httpPort: live.port });
  const send = vi.spyOn(transport, 'sendRequest');

  try {
    const response = await sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' });
    assert.deepEqual(response, { ok: true, data: { via: 'live' } });
    assert.equal(send.mock.calls.at(-1)?.[5]?.timeoutRecovery, 'none');

    await sendToDaemon(request(stateDir));
    assert.equal(send.mock.calls.at(-1)?.[5]?.timeoutRecovery, 'retire-unresponsive');
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(live.server);
  }
});

test('a remote connection never starts a local daemon in either lifecycle', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir } = stateDirAndPaths();
  const unreachable = await startScriptedDaemon(okResult({}));
  await closeLoopbackServer(unreachable.server);
  const remote = { daemonBaseUrl: `http://127.0.0.1:${unreachable.port}` };

  for (const daemonLifecycle of ['attach', 'managed'] as const) {
    const error = await failureOf(sendToDaemon(request(stateDir, remote), { daemonLifecycle }));
    assert.match(error.message, /Remote daemon is unavailable/);
  }
  assert.equal(spawn.mock.calls.length, 0);
});

test('ensureDaemon starts a missing daemon and reports why', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(paths, fresh.port);
  const started: Array<[string, unknown]> = [];

  try {
    const connection = await ensureDaemon({
      stateDir,
      daemonTransport: 'http',
      onStart: (reason, previous) => started.push([reason, previous]),
    });

    assert.equal(connection.started, true);
    assert.equal(connection.stateDir, paths.baseDir);
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(started, [['missing', undefined]]);
    assert.equal('token' in connection.daemon, false, 'the connection carries no credentials');

    const again = await ensureDaemon({ stateDir, daemonTransport: 'http' });
    assert.equal(again.started, false);
    assert.equal(again.daemon.pid, connection.daemon.pid);
    assert.equal(spawn.mock.calls.length, 1, 'a usable daemon is reused');
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('ensureDaemon ignores a remote base URL in the environment', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(paths, fresh.port);
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'http://127.0.0.1:1');

  try {
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });
    assert.equal(connection.started, true);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('ensureDaemon replaces an incompatible idle daemon through a fenced quiesce request', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const leaver = createDaemonLeaver();
  const stale = await startScriptedDaemon(draining, { afterRpc: leaver.leave });
  const fresh = await startScriptedDaemon(okResult({}));
  const { child, info } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  leaver.pid = child.pid;
  launchesFreshDaemonAt(paths, fresh.port);
  const started: Array<[string, { pid: number; version?: string } | undefined]> = [];

  try {
    const connection = await ensureDaemon({
      stateDir,
      daemonTransport: 'http',
      onStart: (reason, previous) => started.push([reason, previous]),
    });

    assert.equal(connection.started, true);
    assert.deepEqual(stale.rpcCommands, [DAEMON_QUIESCE_COMMAND]);
    assert.equal(stale.rpcRequests[0]?.params.token, 'local-secret');
    assert.deepEqual(stale.rpcRequests[0]?.params.input, {
      pid: info.pid,
      processStartTime: info.processStartTime ?? null,
    });
    assert.deepEqual(started, [
      [
        'incompatible',
        {
          pid: child.pid,
          version: '0.0.0-stale',
          codeOrigin: 'checkout',
          codeSignature: currentDaemonCodeSignature(),
          processStartTime: info.processStartTime,
        },
      ],
    ]);
    assert.equal(
      isProcessAlive(child.pid),
      false,
      'the drained daemon is gone before its successor',
    );
    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(leaver.clientSignals, [], 'the client signaled nothing');
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test.for([
  {
    name: 'a request in flight',
    census: { inFlightRequests: 1, sessions: 0, repairSessions: 0, leases: 0 },
  },
  {
    name: 'a live lease',
    census: { inFlightRequests: 0, sessions: 0, repairSessions: 0, leases: 1 },
  },
])('ensureDaemon refuses to replace a daemon holding $name', async ({ census }, t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(busy(census));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-busy');
    assert.equal(error.details?.inFlightRequests, census.inFlightRequests);
    assert.equal(error.details?.leases, census.leases);
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('ensureDaemon tells a daemon that is still starting up apart from a busy one', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(
    busy({ startingUp: true, inFlightRequests: 0, sessions: 0, repairSessions: 0, leases: 0 }),
  );
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-busy');
    assert.equal(error.details?.startingUp, true);
    assert.match(String(error.details?.hint), /still starting up\. Retry in a moment/);
    assert.match(String(error.details?.hint), /agent-device daemon stop --state-dir /);
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('ensureDaemon takes a refusal from its typed reason, not from its wording', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Daemon is busy and was not asked to leave.',
      details: { reason: 'something-else' },
    },
  });
  await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));
    // The refusal's own typed reason is what surfaces; its wording decided nothing.
    assert.equal(error.details?.reason, 'something-else');
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('ensureDaemon never replaces a daemon that predates the quiesce capability', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const old = await startScriptedDaemon(draining);
  const { child } = await registerDaemon(paths, { httpPort: old.port, version: '0.0.0-old' });

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-incompatible');
    assert.equal(error.details?.mismatch, 'no-quiesce');
    assert.deepEqual(old.rpcCommands, [], 'a daemon that cannot answer is not asked');
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(old.server);
  }
});

test('ensureDaemon retires a daemon that timed out on quiesce and answers no liveness probe', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  // Bound together before the dead one is closed, so the fresh daemon cannot be handed its port.
  const closed = await startScriptedDaemon(okResult({}));
  const fresh = await startScriptedDaemon(okResult({}));
  await closeLoopbackServer(closed.server);
  const { child } = await registerDaemon(paths, {
    httpPort: closed.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  launchesFreshDaemonAt(paths, fresh.port);
  vi.spyOn(transport, 'sendRequest').mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    }),
  );

  try {
    const started: Array<[string, number | undefined]> = [];
    const connection = await ensureDaemon({
      stateDir,
      daemonTransport: 'http',
      onStart: (reason, previous) => started.push([reason, previous?.pid]),
    });

    assert.equal(connection.started, true);
    assert.equal(isProcessAlive(child.pid), false);
    // Never shown to be idle, so it is reported like an unreachable daemon, not an incompatible one.
    assert.deepEqual(started, [['missing', child.pid]]);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

// The route that force-retires a daemon which timed out on quiesce and answered no probe. A connect
// the HOST refused is not a missed probe, so this daemon is neither retired nor spawned over.
test('ensureDaemon reports a host denial instead of retiring a daemon whose quiesce timed out', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  vi.spyOn(transport, 'sendRequest').mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    }),
  );
  const liveness = await import('../daemon-client-liveness-probe.ts');
  vi.spyOn(liveness, 'answersLivenessProbe').mockResolvedValue({
    reachable: false,
    denial: { errno: 'EPERM', transport: 'socket', port: stale.port },
  });

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-connect-denied');
    assert.equal(error.details?.errno, 'EPERM');
    assert.match(String(error.details?.hint), /A sandbox around this command/);
    assert.equal(isProcessAlive(child.pid), true, 'a refused probe authorizes no signal');
    assert.equal(spawn.mock.calls.length, 0, 'a daemon this client cannot see is not replaced');
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('ensureDaemon keeps a daemon that timed out on quiesce but still answers a probe', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const slow = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: slow.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  vi.spyOn(transport, 'sendRequest').mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    }),
  );

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon_transport_timeout');
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(slow.server);
  }
});

const instanceMismatch = {
  ok: false,
  error: {
    code: 'COMMAND_FAILED',
    message: 'Quiesce request names a different daemon instance.',
    details: { reason: 'daemon-instance-mismatch' },
  },
};

test('a live daemon on another transport is quiesced, never killed as unreachable', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const leaver = createDaemonLeaver();
  const live = await startScriptedSocketDaemon(
    { ok: true, data: { outcome: 'draining' } },
    { afterCommand: leaver.leave },
  );
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    socketPort: live.port,
    capabilities: ['quiesce'],
  });
  leaver.pid = child.pid;
  launchesFreshDaemonAt(paths, fresh.port);
  const started: string[] = [];

  try {
    // Same version and code, served over the socket only; this client asks for HTTP.
    await ensureDaemon({
      stateDir,
      daemonTransport: 'http',
      onStart: (reason) => started.push(reason),
    });

    assert.deepEqual(live.commands, [DAEMON_QUIESCE_COMMAND]);
    assert.deepEqual(started, ['incompatible']);
    assert.equal(isProcessAlive(child.pid), false, 'it left because it agreed to');
    assert.deepEqual(leaver.clientSignals, [], 'the client signaled nothing');
  } finally {
    await closeLoopbackServer(live.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('a live daemon on another transport is left alone when it cannot be asked to leave', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const live = await startScriptedSocketDaemon({ ok: true, data: { outcome: 'draining' } });
  const { child } = await registerDaemon(paths, { socketPort: live.port });

  try {
    const ensured = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));
    assert.equal(ensured.details?.reason, 'daemon-incompatible');
    assert.equal(ensured.details?.mismatch, 'no-quiesce');

    const attached = await failureOf(
      sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }),
    );
    assert.equal(attached.details?.reason, 'daemon-incompatible');
    assert.equal(attached.details?.mismatch, 'transport');

    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
    assert.deepEqual(live.commands, []);
  } finally {
    await closeLoopbackServer(live.server);
  }
});

test('ensureDaemon judges again after the daemon it addressed turned out to be gone', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const leaver = createDaemonLeaver();
  const stale = await startScriptedDaemon(draining, { afterRpc: leaver.leave });
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  leaver.pid = child.pid;
  launchesFreshDaemonAt(paths, fresh.port);
  const actualSend = transport.sendRequest;
  vi.spyOn(transport, 'sendRequest').mockResolvedValueOnce(instanceMismatch);

  try {
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });

    assert.equal(connection.started, true);
    assert.equal(typeof actualSend, 'function');
    assert.deepEqual(
      stale.rpcCommands,
      [DAEMON_QUIESCE_COMMAND],
      'the second judgement asked again',
    );
    assert.deepEqual(leaver.clientSignals, [], 'the client signaled nothing');
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('ensureDaemon reports contention when the daemon keeps changing under it', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(instanceMismatch);
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  registrationLockStaysAsRecorded(paths);
  const clock = judgeAgainBudgetOnMovedClock(15_000);

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-lifecycle-contended');
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
    assertJudgedAgainForTheFullBudget(clock, 15_000);
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('ensureDaemon does not start a daemon over one it could not confirm retired', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const closed = await startScriptedDaemon(okResult({}));
  await closeLoopbackServer(closed.server);
  const { child } = await registerDaemon(paths, {
    httpPort: closed.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  vi.spyOn(transport, 'sendRequest').mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'Daemon request timed out', {
      reason: 'daemon_transport_timeout',
    }),
  );
  const actualKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === child.pid && signal !== 0) {
      throw Object.assign(new Error('refused'), { code: 'EPERM' });
    }
    return actualKill(pid, signal);
  });

  const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

  assert.equal(error.details?.reason, 'daemon_retirement_unconfirmed');
  assert.equal(spawn.mock.calls.length, 0);
});

test('ensureDaemon quiesces an incompatible daemon that wins a startup race instead of retiring it', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const leaver = createDaemonLeaver();
  const stale = await startScriptedDaemon(draining, { afterRpc: leaver.leave });
  const fresh = await startScriptedDaemon(okResult({}));
  const barrier = path.join(paths.baseDir, 'contender-barrier');
  fs.mkdirSync(paths.baseDir, { recursive: true });
  vi.mocked(sleep).mockImplementation(actualRetry.sleep);
  let winner: ReturnType<typeof spawnRegisteredDaemonFixture> | undefined;
  spawn.mockImplementationOnce(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: {
          httpPort: fresh.port,
          token: 'local-secret',
          version: readVersion(),
          codeOrigin: 'checkout',
          codeSignature: currentDaemonCodeSignature(),
        },
        acquisitionBarrier: barrier,
        companions: [
          {
            kind: 'registered',
            paths,
            fields: {
              httpPort: stale.port,
              token: 'local-secret',
              version: '0.0.0-stale',
              codeOrigin: 'checkout',
              codeSignature: currentDaemonCodeSignature(),
              capabilities: ['quiesce'],
            },
            observe(child) {
              winner = child;
              leaver.pid = child.pid;
              // Released whether or not the winner published, so the launched child never waits forever.
              const release = () => fs.writeFileSync(barrier, 'go');
              void waitForRegisteredDaemonFixture(paths, child).then(release, release);
            },
          },
        ],
      },
    ]),
  );
  launchesFreshDaemonAt(paths, fresh.port);

  try {
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });

    assert.equal(connection.started, true);
    assert.deepEqual(stale.rpcCommands, [DAEMON_QUIESCE_COMMAND], 'the racer was asked to leave');
    assert.ok(winner);
    assert.equal(isProcessAlive(winner.pid), false);
    assert.equal(spawn.mock.calls.length, 2, 'the second start follows the quiesce');
    assert.deepEqual(leaver.clientSignals, [], 'the client signaled nothing');
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('a registration whose process is gone is not running, whatever version it names', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(draining);
  const fresh = await startScriptedDaemon(okResult({}));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({
      httpPort: stale.port,
      token: 'local-secret',
      pid: 999_999_999,
      version: '0.0.0-stale',
      processStartTime: 'gone',
      capabilities: ['quiesce'],
    }),
  );

  try {
    const attached = await failureOf(
      sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }),
    );
    assert.equal(attached.details?.reason, 'daemon-not-running');

    // ensureDaemon replaces the dead registration without asking anyone to leave.
    launchesFreshDaemonAt(paths, fresh.port);
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });
    assert.equal(connection.started, true);
    assert.deepEqual(stale.rpcCommands, []);
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('a quiesce the daemon never hears is judged again, not reported as a transport failure', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const closed = await startScriptedDaemon(draining);
  await closeLoopbackServer(closed.server);
  const { child } = await registerDaemon(paths, {
    httpPort: closed.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  registrationLockStaysAsRecorded(paths);
  const clock = judgeAgainBudgetOnMovedClock(15_000);

  const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

  assert.equal(error.details?.reason, 'daemon-lifecycle-contended');
  assert.equal(isProcessAlive(child.pid), true);
  assert.equal(spawn.mock.calls.length, 0);
  assertJudgedAgainForTheFullBudget(clock, 15_000);
});

test('a client call that outlives its case is still running when the next one begins', async (t) => {
  if (!(await withLoopback(t))) return;
  // This call is deliberately not awaited. Its first start answers 250 ms late and the retry between
  // the two starts waits 150 ms of real time, so its second start reaches the shared launch seam
  // roughly 400 ms after this case's body has ended and its seams have been reset. Those waits are
  // this crossing's own window, not a production budget.
  const { stateDir } = stateDirAndPaths();
  vi.mocked(sleep).mockImplementation(actualRetry.sleep);
  const exit = { pid: 999_999, exitCode: 1 };
  const startAnsweredLate = new Promise<void>((resolve) => setTimeout(resolve, 250));
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      { kind: 'exit', exit, exitGate: startAnsweredLate },
      { kind: 'exit', exit },
    ]),
  );

  void ensureDaemon({ stateDir, daemonTransport: 'http' });

  // The call must have reached its launch seam, and be one start from its end, before its case ends.
  for (let poll = 0; spawn.mock.calls.length === 0 && poll < 100; poll += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(spawn.mock.calls.length, 1, 'the call had reached its launch seam in its own case');
  assert.equal(inFlightClientCalls.size, 1, 'the call was still running when its case ended');
});

test('the call that outlived the case before this one records no launch here', async (t) => {
  if (!(await withLoopback(t))) return;
  // The case above ends while its client call is still running, and that call's second start lands
  // about 400 ms into this one. This case asks its client for nothing, so nothing may be recorded on
  // the launch seam while it waits: any recorded start belongs to the outlived call, spending this
  // case's seams — which is how one slow case used to fail the case after it.
  assert.equal(inFlightClientCalls.size, 0, 'the case before this one left no call in flight');
  for (let poll = 0; poll < 10; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(spawn.mock.calls.length, 0, 'no daemon launch may be recorded during this case');
  }
});
