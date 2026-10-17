import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, supportsLoopbackBind } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { finishRegisteredDaemonFixtures } from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  busy,
  draining,
  launchesFreshDaemonAt,
  okResult,
  registerDaemon,
  startScriptedDaemon,
  stateDirAndPaths,
} from './explicit-lifecycle-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { withEnsuredDaemon } from '../daemon-client-ensuring.ts';
import { daemonNotRunningError } from '../daemon-lifecycle-errors.ts';
import { createEnsuredDaemonTransport, type sendToDaemon } from '../daemon-client.ts';
import * as ensureModule from '../daemon-client-ensure.ts';

// The CLI and MCP reach the daemon through `withEnsuredDaemon`. The transport underneath is a
// recorder, so what these tests read is the lifecycle each request was handed and what ensuring
// did to the state directory before it.

const spawn = vi.mocked(runCmdDetachedMonitored);

afterEach(async () => {
  vi.unstubAllEnvs();
  spawn.mockReset();
  await finishRegisteredDaemonFixtures();
});

function recordingTransport() {
  const sent: Array<{ command: string; lifecycle: string | undefined }> = [];
  const transport: typeof sendToDaemon = async (req, context) => {
    sent.push({ command: req.command, lifecycle: context?.daemonLifecycle });
    return { ok: true, data: {} };
  };
  return { sent, transport };
}

function request(command: string, flags: Record<string, unknown>) {
  return { session: 'default', command, positionals: [], flags } as Parameters<
    typeof sendToDaemon
  >[0];
}

test('the first request ensures a missing daemon once and every request attaches to it', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);
  const flags = { stateDir, daemonTransport: 'http' };

  try {
    assert.equal(spawn.mock.calls.length, 0, 'building the transport starts nothing');
    await ensuring(request('devices', flags));
    await ensuring(request('snapshot', flags));

    assert.equal(spawn.mock.calls.length, 1);
    assert.deepEqual(sent, [
      { command: 'devices', lifecycle: 'attach' },
      { command: 'snapshot', lifecycle: 'attach' },
    ]);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('an idle incompatible daemon is replaced, and the replacement is reported', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(draining);
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const { sent, transport } = recordingTransport();
  const replaced: Array<{ stateDir: string; pid: number; reason: string }> = [];
  const ensuring = withEnsuredDaemon(transport, {
    onReplaced: (event) =>
      replaced.push({ stateDir: event.stateDir, pid: event.previous.pid, reason: event.reason }),
  });

  try {
    await ensuring(request('devices', { stateDir, daemonTransport: 'http' }));

    assert.deepEqual(replaced, [
      { stateDir: paths.baseDir, pid: child.pid, reason: 'incompatible' },
    ]);
    assert.equal(sent[0]?.lifecycle, 'attach');
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('a busy incompatible daemon fails the request before it is sent and keeps running', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(
    busy({ inFlightRequests: 0, sessions: 1, repairSessions: 0, leases: 0 }),
  );
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);

  try {
    const failure = await ensuring(request('devices', { stateDir, daemonTransport: 'http' })).then(
      () => assert.fail('expected the request to be refused'),
      (error: unknown) => error,
    );

    assert.ok(failure instanceof AppError);
    assert.equal(failure.details?.reason, 'daemon-busy');
    assert.deepEqual(sent, []);
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('a remote connection passes through without ensuring or choosing a lifecycle', async () => {
  const { stateDir } = stateDirAndPaths();
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);

  await ensuring(request('devices', { stateDir, daemonBaseUrl: 'http://127.0.0.1:1' }));
  vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'http://127.0.0.1:1');
  await ensuring(request('snapshot', { stateDir }));

  assert.deepEqual(sent, [
    { command: 'devices', lifecycle: undefined },
    { command: 'snapshot', lifecycle: undefined },
  ]);
  assert.equal(spawn.mock.calls.length, 0);
});

test('a one-shot replay on its own private daemon passes through, an explicit state dir does not', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);

  try {
    await ensuring(request('replay', { daemonTransport: 'http' }));
    assert.deepEqual(sent, [{ command: 'replay', lifecycle: undefined }]);
    assert.equal(spawn.mock.calls.length, 0);

    await ensuring(request('replay', { stateDir, daemonTransport: 'http' }));
    assert.equal(sent[1]?.lifecycle, 'attach');
    assert.equal(spawn.mock.calls.length, 1);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('a daemon that disappears between requests is ensured again before the next one is sent', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const sent: string[] = [];
  let daemonGone = false;
  const transport: typeof sendToDaemon = async (req) => {
    if (daemonGone) {
      daemonGone = false;
      throw daemonNotRunningError(stateDir);
    }
    sent.push(req.command);
    return { ok: true, data: {} };
  };
  const ensuring = withEnsuredDaemon(transport);
  const flags = { stateDir, daemonTransport: 'http' };

  try {
    await ensuring(request('devices', flags));
    assert.equal(spawn.mock.calls.length, 1);

    daemonGone = true;
    await finishRegisteredDaemonFixtures();
    launchesFreshDaemonAt(spawn, paths, fresh.port);
    await ensuring(request('snapshot', flags));

    assert.deepEqual(sent, ['devices', 'snapshot']);
    assert.equal(spawn.mock.calls.length, 2, 'the second ensure started a daemon again');
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('a registered daemon that answers nothing is replaced and reported as unreachable', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  // Both are bound before the dead one is closed, so the fresh daemon cannot be handed its port.
  const closed = await startScriptedDaemon(okResult({}));
  const fresh = await startScriptedDaemon(okResult({}));
  await closeLoopbackServer(closed.server);
  const { child } = await registerDaemon(paths, { httpPort: closed.port });
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const { transport } = recordingTransport();
  const replaced: string[] = [];
  const ensuring = withEnsuredDaemon(transport, {
    onReplaced: (event) => replaced.push(`${event.reason}:${event.previous.pid}`),
  });

  try {
    await ensuring(request('devices', { stateDir, daemonTransport: 'http' }));

    assert.deepEqual(replaced, [`unreachable:${child.pid}`]);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('a failed ensure is retried by the next request instead of being remembered', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(
    busy({ inFlightRequests: 1, sessions: 0, repairSessions: 0, leases: 0 }),
  );
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);
  const flags = { stateDir, daemonTransport: 'http' };

  try {
    await assert.rejects(
      ensuring(request('devices', flags)),
      (error: unknown) => error instanceof AppError && error.details?.reason === 'daemon-busy',
    );
    assert.deepEqual(sent, []);

    // The busy daemon goes away; the same transport ensures again rather than replaying the failure.
    await finishRegisteredDaemonFixtures();
    assert.equal(isProcessAlive(child.pid), false);
    launchesFreshDaemonAt(spawn, paths, fresh.port);
    await ensuring(request('devices', flags));

    assert.deepEqual(sent, [{ command: 'devices', lifecycle: 'attach' }]);
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('concurrent first requests share one ensure through the CLI and MCP transport', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({ via: 'fresh' }));
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const ensuring = createEnsuredDaemonTransport();
  const flags = { stateDir, daemonTransport: 'http' };
  const ensure = vi.spyOn(ensureModule, 'ensureDaemon');

  try {
    const responses = await Promise.all([
      ensuring(request('devices', flags)),
      ensuring(request('snapshot', flags)),
    ]);

    assert.deepEqual(responses, [
      { ok: true, data: { via: 'fresh' } },
      { ok: true, data: { via: 'fresh' } },
    ]);
    assert.equal(ensure.mock.calls.length, 1, 'one ensure for both requests');
    assert.equal(spawn.mock.calls.length, 1, 'one daemon start for both requests');
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('a request canceled before it starts does not start a daemon', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { stateDir, paths } = stateDirAndPaths();
  const fresh = await startScriptedDaemon(okResult({}));
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const { sent, transport } = recordingTransport();
  const ensuring = withEnsuredDaemon(transport);
  const canceled = AbortSignal.abort();

  try {
    await ensuring(request('devices', { stateDir, daemonTransport: 'http' }), { signal: canceled });

    assert.equal(spawn.mock.calls.length, 0);
    assert.deepEqual(sent, [{ command: 'devices', lifecycle: 'attach' }]);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});
