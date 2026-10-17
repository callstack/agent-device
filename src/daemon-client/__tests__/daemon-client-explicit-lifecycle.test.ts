import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, supportsLoopbackBind } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { DAEMON_QUIESCE_COMMAND } from '@agent-device/daemon-contracts/daemon-resolution';
import { DAEMON_STARTUP_EXIT_CODES } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import {
  finishRegisteredDaemonFixtures,
  spawnRegisteredDaemonFixture,
  waitForRegisteredDaemonFixture,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from '../../__tests__/test-utils/daemon-http-fixture.ts';
import {
  busy,
  createDaemonLeaver,
  draining,
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
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import * as transport from '../daemon-client-transport.ts';
import { sendToDaemon } from '../daemon-client.ts';
import { ensureDaemon } from '../daemon-client-ensure.ts';

// The explicit lifecycle: what an attach client may never do, and what `ensureDaemon` may do only
// through the daemon's own answer. Daemons here are loopback stand-ins registered by real children,
// so a kill or a spawn is observable as a dead pid or a call to the launch seam.

const spawn = vi.mocked(runCmdDetachedMonitored);
const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);
const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  spawn.mockReset();
  vi.mocked(sleep).mockReset();
  vi.mocked(sleep).mockImplementation(async () => {});
  await finishRegisteredDaemonFixtures();
});

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

function identityIn(error: AppError, key: 'daemon' | 'client'): { pid?: number; version?: string } {
  return (error.details?.[key] ?? {}) as { pid?: number; version?: string };
}

async function failureOf(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AppError, 'expected a typed AppError');
    return error;
  }
  return assert.fail('expected the call to reject');
}

async function withLoopback(t: { skip: (note: string) => void }): Promise<boolean> {
  if (await supportsLoopbackBind()) return true;
  t.skip('loopback listeners are not permitted in this environment');
  return false;
}

test('attach reports a missing daemon without starting one', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();

  const error = await failureOf(sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }));

  assert.equal(error.details?.reason, 'daemon-not-running');
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

test('attach reports a registered daemon that answers nothing as not running and leaves it', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  const closed = await startScriptedDaemon(okResult({}));
  await closeLoopbackServer(closed.server);
  const { child } = await registerDaemon(paths, { httpPort: closed.port });

  const error = await failureOf(sendToDaemon(request(stateDir), { daemonLifecycle: 'attach' }));

  assert.equal(error.details?.reason, 'daemon-not-running');
  assert.equal(identityIn(error, 'daemon').pid, child.pid);
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

  try {
    const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

    assert.equal(error.details?.reason, 'daemon-lifecycle-contended');
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
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
  spawn.mockImplementationOnce((_command, _args, options) => {
    // An incompatible daemon registers just ahead of the one this call launches, which then exits busy.
    winner = spawnRegisteredDaemonFixture(
      paths,
      {
        httpPort: stale.port,
        token: 'local-secret',
        version: '0.0.0-stale',
        codeOrigin: 'checkout',
        codeSignature: currentDaemonCodeSignature(),
        capabilities: ['quiesce'],
      },
      undefined,
    );
    leaver.pid = winner.pid;
    // Released whether or not the winner published, so the launched child never waits forever.
    const release = () => fs.writeFileSync(barrier, 'go');
    void waitForRegisteredDaemonFixture(paths, winner).then(release, release);
    // Our launch loses the race once the winner is registered: it exits with the busy code.
    return actualCommand.runCmdDetachedMonitored(
      process.execPath,
      [
        '-e',
        `const fs=require("fs");setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(${DAEMON_STARTUP_EXIT_CODES.busy})},10)`,
        barrier,
      ],
      options,
    );
  });
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

  const error = await failureOf(ensureDaemon({ stateDir, daemonTransport: 'http' }));

  assert.equal(error.details?.reason, 'daemon-lifecycle-contended');
  assert.equal(isProcessAlive(child.pid), true);
  assert.equal(spawn.mock.calls.length, 0);
});
