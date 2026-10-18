// What a client may do about a runtime a host owns, and what a client pinned to one daemon instance
// will and will not do to reach it. Most of the weight here is in what did NOT happen: nothing was
// signaled, nothing was started, nothing was retired, and no request was dispatched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
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
