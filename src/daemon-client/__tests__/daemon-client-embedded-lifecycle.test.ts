// What a client may do about a runtime a host owns, and what a client pinned to one daemon instance
// will and will not do to reach it. Most of the weight here is in what did NOT happen: nothing was
// signaled, nothing was started, nothing was retired, and no request was dispatched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  skipWhenLoopbackUnavailable,
  listenOnLoopback,
} from '@agent-device/test-kit';
import * as startup from '../daemon-client-startup.ts';
import type { DaemonBinding } from '@agent-device/contracts/client';
import { DAEMON_LIFECYCLE_REASONS } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { finishRegisteredDaemonFixtures } from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
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
import { createDaemonTransport, type sendToDaemon } from '../daemon-client.ts';
import { resolveClientSettings, resolveTimeoutRecovery } from '../daemon-client-lifecycle.ts';
import { readDaemonInfo } from '../daemon-client-metadata.ts';

const spawn = vi.mocked(runCmdDetachedMonitored);

afterEach(async () => {
  vi.restoreAllMocks();
  spawn.mockReset();
  await finishRegisteredDaemonFixtures();
});

function request(stateDir: string) {
  return {
    session: 'default',
    command: 'devices',
    positionals: [],
    flags: { stateDir, daemonTransport: 'http' },
  } as Parameters<typeof sendToDaemon>[0];
}

function pinTo(info: { token: string; pid: number; processStartTime?: string }): DaemonBinding {
  return { token: info.token, pid: info.pid, processStartTime: info.processStartTime ?? '' };
}

/**
 * The signals this code sent at a process. `0` is the liveness probe and is not one; a call with no
 * signal argument is SIGTERM, so an omitted signal counts.
 */
function signalsSent(killSpy: { mock: { calls: Array<unknown[]> } }) {
  return killSpy.mock.calls.filter(([, signal]) => signal !== 0);
}

async function refusalFrom(promise: Promise<unknown>): Promise<AppError> {
  const refusal = await promise.then(
    () => assert.fail('expected the request to be refused'),
    (error: unknown) => error,
  );
  assert.ok(refusal instanceof AppError, String(refusal));
  return refusal;
}

/** A socket stand-in that keeps every request line it was sent, token included. */
async function startRecordingSocketDaemon(expectedToken?: () => string) {
  const requests: Record<string, any>[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (!buffered.includes('\n')) return;
      const request = JSON.parse(buffered) as Record<string, unknown>;
      requests.push(request);
      const response =
        expectedToken && request.token !== expectedToken()
          ? { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid daemon token' } }
          : { ok: true, data: { devices: [] } };
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });
  return { server, port: await listenOnLoopback(server), requests };
}

/**
 * A stale daemon of an incompatible version: the shape that makes a managed client want this state
 * directory. The ownership field is then the only thing that decides whether it may take it. The
 * stand-in answers nothing useful on purpose: the embedded refusal happens before the client asks
 * this daemon anything.
 */
async function startStaleRegistration(ownership?: 'embedded') {
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await startScriptedDaemon(okResult({}));
  const registered = await registerDaemon(paths, {
    httpPort: daemon.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
    ...(ownership ? { ownership } : {}),
  });
  return { stateDir, paths, daemon, ...registered };
}

/**
 * The same stale registration left behind by an owner that died: a real child publishes it and is then
 * killed without retiring anything, so the record names a lifetime the process table can disprove. Its
 * record and lock stay, which is the wedged state directory every managed command must get past.
 */
async function crashedStaleRegistration(ownership: 'embedded' | 'unrecognized' | 'detached') {
  const { stateDir, paths } = stateDirAndPaths();
  const registered = await registerDaemon(paths, {
    // Nothing answers this port: the point is that the client never asks the dead owner anything.
    httpPort: 1,
    version: '0.0.0-stale',
    ...(ownership === 'embedded' ? { ownership: 'embedded' } : {}),
  });
  if (ownership === 'unrecognized') {
    const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'));
    fs.writeFileSync(paths.infoPath, JSON.stringify({ ...record, ownership: 'sideways' }));
    assert.equal(readDaemonInfo(paths.infoPath)?.ownership, 'unknown');
  }
  process.kill(registered.child.pid, 'SIGKILL');
  await registered.child.exited;
  assert.equal(isProcessAlive(registered.child.pid), false);
  return { stateDir, paths, ...registered };
}

for (const [ownership, reason, hint] of [
  ['embedded', DAEMON_LIFECYCLE_REASONS.ownerEmbedded, /Close the host that started it/],
  ['sideways', 'daemon-owner-unrecognized', /Update agent-device/],
] as const)
  test(`a managed client preserves a ${ownership} owner`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { stateDir, paths, daemon, child } = await startStaleRegistration('embedded');
    if (ownership !== 'embedded') {
      const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'));
      fs.writeFileSync(paths.infoPath, JSON.stringify({ ...record, ownership }));
      assert.equal(readDaemonInfo(paths.infoPath)?.ownership, 'unknown');
    }
    const killSpy = vi.spyOn(process, 'kill');
    try {
      const refusal = await refusalFrom(
        createDaemonTransport(createTestHostEnvironment())(request(stateDir)),
      );
      assert.equal(refusal.details?.reason, reason);
      assert.match(String(refusal.details?.hint), hint);
      assert.deepEqual(daemon.rpcCommands, [], 'the takeover was never attempted');
      assert.equal(spawn.mock.calls.length, 0);
      assert.deepEqual(signalsSent(killSpy), []);
      assert.equal(isProcessAlive(child.pid), true);
      assert.equal(readDaemonInfo(paths.infoPath)?.pid, child.pid);
    } finally {
      await closeLoopbackServer(daemon.server);
    }
  });

test('the same record with no host owner is still the takeover this client performs', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // One field differs from the row above, and it changes everything: a detached contender of the wrong
  // version is a daemon this client ends and replaces. That is what makes the embedded refusal a
  // boundary rather than a general rule about taking over.
  const { stateDir, paths } = stateDirAndPaths();
  const stale = await startScriptedDaemon(okResult({}));
  const fresh = await startScriptedDaemon(okResult({ devices: [] }));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  launchesFreshDaemonAt(spawn, paths, fresh.port);
  const killSpy = vi.spyOn(process, 'kill');

  try {
    assert.equal(readDaemonInfo(paths.infoPath)?.ownership, 'detached');
    const response = await createDaemonTransport(createTestHostEnvironment())(request(stateDir));

    assert.equal(response.ok, true);
    assert.equal(spawn.mock.calls.length, 1, 'the detached contender was replaced');
    // The signal the embedded row proves never happens is exactly what this path is allowed to do.
    assert.deepEqual(
      killSpy.mock.calls.filter(([target, signal]) => target === child.pid && signal === 'SIGTERM'),
      [[child.pid, 'SIGTERM']],
    );
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

for (const ownership of ['embedded', 'unrecognized', 'detached'] as const)
  test(`a managed command recovers the record a crashed ${ownership} owner left behind`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    // The wedged state directory: an incompatible-version record and its lock, naming a lifetime the
    // process table disproves. Ownership is judged inside the retirement, so all three recover: the
    // dead owner is proven gone, nothing is signaled, and the managed command starts a fresh daemon.
    const { stateDir, paths, child } = await crashedStaleRegistration(ownership);
    const fresh = await startScriptedDaemon(okResult({ devices: [] }));
    launchesFreshDaemonAt(spawn, paths, fresh.port);
    const killSpy = vi.spyOn(process, 'kill');

    try {
      const response = await createDaemonTransport(createTestHostEnvironment())(request(stateDir));

      assert.equal(response.ok, true, JSON.stringify(response));
      assert.equal(spawn.mock.calls.length, 1, 'the state directory was taken over, not wedged');
      // The dead owner's record is gone: the fresh daemon's registration names a live process, and the
      // dead lifetime received no signal — its exit was proved from the process table, not caused.
      assert.notEqual(readDaemonInfo(paths.infoPath)?.pid, child.pid);
      assert.deepEqual(
        signalsSent(killSpy).filter(([target]) => target === child.pid),
        [],
      );
    } finally {
      await closeLoopbackServer(fresh.server);
    }
  });

test('timeout recovery asks only whether this client may, and attach never may', () => {
  const { stateDir } = stateDirAndPaths();
  const managed = resolveClientSettings(
    request(stateDir),
    undefined,
    createTestHostEnvironment(),
    'managed',
  );
  const attach = resolveClientSettings(
    request(stateDir),
    undefined,
    createTestHostEnvironment(),
    'attach',
  );
  // Recovery is the retirement's judgement, so the client decides only whether it may ask at all: an
  // attach client never does, and every other lifecycle asks. The retirement answers for the record's
  // owner — a live embedded or unrecognized one is refused without a signal, which
  // daemon-registration-embedded-owner.test.ts pins at that seam for both modes.
  assert.equal(resolveTimeoutRecovery(managed), 'retire-unresponsive');
  assert.equal(resolveTimeoutRecovery(attach), 'none');
});

test('a matching pin does not bypass attach compatibility checks', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, daemon, info } = await startStaleRegistration('embedded');
  try {
    const refusal = await refusalFrom(
      createDaemonTransport(createTestHostEnvironment())(request(stateDir), {
        daemonBinding: pinTo(info),
      }),
    );
    assert.equal(refusal.details?.reason, 'daemon-incompatible');
    assert.deepEqual(daemon.rpcCommands, []);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a pinned client dispatches to the instance it pins and starts nothing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await startRecordingSocketDaemon();
  const { child, info } = await registerDaemon(paths, {
    socketPort: daemon.port,
    ownership: 'embedded',
  });

  try {
    const transport = createDaemonTransport(createTestHostEnvironment());
    const response = await transport(
      {
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'socket' },
      } as Parameters<typeof sendToDaemon>[0],
      { daemonBinding: pinTo(info) },
    );

    assert.equal(response.ok, true);
    // The credential that went out is the one the pin names, not one re-read from a record that may
    // have changed since the pin was handed out.
    assert.deepEqual(
      daemon.requests.map((entry) => entry.command),
      ['devices'],
    );
    assert.equal(daemon.requests[0]?.token, info.token);
    assert.equal(spawn.mock.calls.length, 0, 'a pinned client starts no daemon');
    assert.equal(isProcessAlive(child.pid), true);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a pinned client refuses an instance that is not the one it pins', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await startScriptedDaemon(okResult({ devices: [] }));
  const { child, info } = await registerDaemon(paths, {
    httpPort: daemon.port,
    ownership: 'embedded',
  });
  // A runtime that took the state directory since the pin was handed out: same place, other instance.
  const pin = { ...pinTo(info), token: 'a-different-instance' };

  try {
    const transport = createDaemonTransport(createTestHostEnvironment());
    const refusal = await refusalFrom(transport(request(stateDir), { daemonBinding: pin }));

    assert.equal(refusal.details?.reason, 'daemon-binding-mismatch');
    // The refusal names the instance that is really there so an operator can tell which host to ask,
    // and never the credentials of either side.
    assert.equal((refusal.details as { registered: { pid: number } }).registered.pid, child.pid);
    assert.doesNotMatch(JSON.stringify(refusal.details), /local-secret|a-different-instance/);
    assert.deepEqual(daemon.rpcCommands, [], 'another instance is never dispatched to');
    assert.equal(spawn.mock.calls.length, 0, 'a pin is never satisfied by starting a daemon');
    assert.equal(isProcessAlive(child.pid), true);
    // The refusal read the record and changed nothing about it: the pinned-away instance still owns
    // the state directory, which is what a client that pins must leave behind.
    assert.equal(readDaemonInfo(paths.infoPath)?.pid, child.pid);
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

test('a pinned client refuses a state directory that registers no daemon', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, paths } = stateDirAndPaths();
  const daemon = await startRecordingSocketDaemon();
  const { info } = await registerDaemon(paths, { socketPort: daemon.port });
  const pin = pinTo(info);
  await finishRegisteredDaemonFixtures();
  assert.equal(readDaemonInfo(paths.infoPath), null);

  try {
    const transport = createDaemonTransport(createTestHostEnvironment());
    const refusal = await refusalFrom(transport(request(stateDir), { daemonBinding: pin }));

    assert.equal(refusal.details?.reason, 'daemon-binding-mismatch');
    assert.equal(daemon.requests.length, 0, 'an absent instance is not replaced by a live one');
    assert.equal(spawn.mock.calls.length, 0, 'a pin names an instance, not a place to start one');
  } finally {
    await closeLoopbackServer(daemon.server);
  }
});

// A pin is a local instance's identity, and a base URL sends requests somewhere else. Silently
// preferring either one would make the pin a way to redirect a remote client, or to ignore it.
test('a client that pins a local daemon and names a base URL is refused where settings are read', () => {
  const pin: DaemonBinding = { token: 'token', pid: 4242, processStartTime: 'start' };
  // Loopback so the row reads as the combination under test, not as the separate rule that a remote
  // URL outside the machine needs an auth token.
  const remote = 'http://127.0.0.1:9';

  for (const [label, resolve] of [
    [
      'from the request flags',
      () =>
        resolveClientSettings(
          { ...request(stateDirAndPaths().stateDir), flags: { daemonBaseUrl: remote } },
          undefined,
          createTestHostEnvironment(),
          'managed',
          pin,
        ),
    ],
    // The env form is the one that bites: a pin handed to a client on a machine that exports the URL.
    [
      'from the environment',
      () =>
        resolveClientSettings(
          request(stateDirAndPaths().stateDir),
          undefined,
          createTestHostEnvironment({ env: { AGENT_DEVICE_DAEMON_BASE_URL: remote } }),
          'managed',
          pin,
        ),
    ],
  ] as const) {
    let refusal: AppError | undefined;
    try {
      resolve();
      assert.fail(`${label}: expected the combination to be refused`);
    } catch (error) {
      assert.ok(error instanceof AppError, `${label}: ${String(error)}`);
      refusal = error;
    }
    assert.equal(refusal.code, 'INVALID_ARGS', label);
    assert.equal(refusal.details?.reason, 'daemon_binding_with_remote_base_url', label);
    assert.match(String(refusal.details?.hint), /Drop the base URL/, label);
  }
});

// An unreadable record cannot authorize a pinned client to dispatch or replace its owner.
test('a pinned client refuses a record it cannot read as an address', async () => {
  const { stateDir, paths } = stateDirAndPaths();
  const pin: DaemonBinding = { token: 'token', pid: 4242, processStartTime: 'start' };
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.infoPath, '{not json', { mode: 0o600 });

  const refusal = await refusalFrom(
    createDaemonTransport(createTestHostEnvironment())(request(stateDir), { daemonBinding: pin }),
  );

  assert.equal(refusal.details?.reason, 'daemon-binding-mismatch');
  assert.match(String(refusal.details?.hint), /daemon\.json/);
  assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), '{not json', 'the refusal changed nothing');
});

test('a pinned client keeps its hands off the state directory it was given', async () => {
  const { stateDir, paths } = stateDirAndPaths();
  const pin: DaemonBinding = { token: 'token', pid: 4242, processStartTime: 'start' };

  const settings = resolveClientSettings(
    request(stateDir),
    undefined,
    createTestHostEnvironment(),
    'managed',
    pin,
  );

  // A private state directory would hold a daemon nobody started, and a pinned client starts none.
  assert.equal(settings.daemonLifecycle, 'attach');
  assert.equal(settings.ownedStateDir, undefined);
  assert.deepEqual(settings.daemonBinding, pin);
  assert.equal(settings.paths.baseDir, paths.baseDir);
});

test('replacement after binding lookup cannot authenticate a pinned request with the new token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { stateDir, paths } = stateDirAndPaths();
  let token = 'local-secret';
  const daemon = await startRecordingSocketDaemon(() => token);
  const { info } = await registerDaemon(paths, { socketPort: daemon.port, ownership: 'embedded' });
  token = info.token;
  const observe = startup.observeLocalDaemon;
  const lookup = vi.spyOn(startup, 'observeLocalDaemon').mockImplementation(async (...args) => {
    const observed = await observe(...args);
    // The replacement reuses the endpoint and process lifetime after this lookup. Its auth token
    // changes, so a request can only succeed here if the client incorrectly adopts the new token.
    token = 'replacement-token';
    const replaced = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8'));
    fs.writeFileSync(paths.infoPath, JSON.stringify({ ...replaced, token }));
    return observed;
  });
  try {
    const response = await createDaemonTransport(createTestHostEnvironment())(
      {
        session: 'default',
        command: 'devices',
        positionals: [],
        flags: { stateDir, daemonTransport: 'socket' },
      },
      { daemonBinding: pinTo(info) },
    );
    assert.equal(lookup.mock.calls.length, 1);
    assert.deepEqual(response, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid daemon token' },
    });
    assert.equal(
      daemon.requests.length,
      1,
      'authentication failure never retries against a replacement',
    );
    assert.equal(daemon.requests[0]?.token, info.token);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    lookup.mockRestore();
    await closeLoopbackServer(daemon.server);
  }
});
