import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { tryAcquireProcessLock, inspectProcessLock } from '@agent-device/host-kit/file';
import {
  readCurrentOwnerIdentity,
  isProcessAlive,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  spawnRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  startHttpDaemonFixture,
  currentDaemonCodeSignature,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';
import { closeLoopbackServer, supportsLoopbackBind } from '../../__tests__/test-utils/loopback.ts';
import { resolveDaemonPaths, type DaemonPaths } from '../../daemon-resolution.ts';
import { sendToDaemon } from '../daemon-client.ts';
import * as lifecycle from '../daemon-client-lifecycle.ts';
import { DAEMON_STARTUP_EXIT_CODES } from '../../daemon-registration-owner.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(actual.readProcessStartTime) };
});
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(),
}));
import { runCmdDetachedMonitored, type ExecDetachedExit } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const spawn = vi.mocked(runCmdDetachedMonitored);
const pause = vi.mocked(sleep);
afterEach(async () => {
  vi.restoreAllMocks();
  await finishRegisteredDaemonFixtures();
  spawn.mockReset();
  pause.mockReset();
});

function request(paths: DaemonPaths, command = 'devices') {
  return {
    session: 'default',
    command,
    positionals: [],
    flags: { stateDir: paths.baseDir, daemonTransport: 'http' as const },
  };
}
function fields(httpPort: number, version = readVersion()) {
  return {
    httpPort,
    token: 'secret',
    version,
    codeOrigin: 'checkout' as const,
    codeSignature: currentDaemonCodeSignature(),
  };
}
async function awaitFile(file: string) {
  for (let attempt = 0; !fs.existsSync(file); attempt += 1) {
    assert.ok(attempt < 200, `fixture did not publish ${file}`);
    await actualRetry.sleep(10);
  }
}

const observationIdentity = readCurrentOwnerIdentity();
test.for([
  {
    proof: 'matching',
    startTime: observationIdentity.startTime,
    infoStart: observationIdentity.startTime,
    expectedAllowed: true,
    expectedState: 'held',
  },
  {
    proof: 'missing',
    startTime: null,
    infoStart: undefined,
    expectedAllowed: false,
    expectedState: 'held',
  },
  {
    proof: 'null',
    startTime: null,
    infoStart: null,
    expectedAllowed: false,
    expectedState: 'held',
  },
  {
    proof: 'empty',
    startTime: '',
    infoStart: '',
    expectedAllowed: false,
    expectedState: 'held',
  },
  {
    proof: 'blank',
    startTime: ' \t ',
    infoStart: ' \t ',
    expectedAllowed: false,
    expectedState: 'held',
  },
  {
    proof: 'absent',
    startTime: null,
    infoStart: undefined,
    expectedAllowed: true,
    expectedState: 'absent',
  },
])(
  'existing registration observation requires proved matching birth times ($proof)',
  async ({ startTime, infoStart, expectedAllowed, expectedState }, t) => {
    if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-observation-proof-'));
    const http = await startHttpDaemonFixture({ devices: [] });
    assert.ok(observationIdentity.startTime?.trim());
    const claim =
      expectedState === 'absent'
        ? undefined
        : tryAcquireProcessLock({
            lockDirPath: paths.lockPath,
            owner: { pid: observationIdentity.pid, startTime, acquiredAtMs: Date.now() },
          });
    assert.ok(!claim || claim.status === 'acquired');
    assert.equal(inspectProcessLock(paths.lockPath).state, expectedState);
    fs.writeFileSync(
      paths.infoPath,
      JSON.stringify({
        ...fields(http.port),
        pid: observationIdentity.pid,
        processStartTime: infoStart,
      }),
    );
    const originalInfo = fs.readFileSync(paths.infoPath, 'utf8');
    spawn.mockImplementation(() => {
      throw new Error('fixture refuses a replacement launch');
    });
    try {
      if (expectedAllowed) {
        assert.equal((await sendToDaemon(request(paths))).ok, true);
        assert.equal(spawn.mock.calls.length, 0);
        assert.equal(http.rpcRequests.length, 1);
      } else {
        await assert.rejects(sendToDaemon(request(paths)), (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.kind, 'daemon_startup_failed');
          return true;
        });
        assert.equal(spawn.mock.calls.length, 1);
        assert.deepEqual(http.seenPaths, []);
      }
      assert.equal(fs.readFileSync(paths.infoPath, 'utf8'), originalInfo);
    } finally {
      if (claim?.status === 'acquired') await claim.acquisition.release();
      await closeLoopbackServer(http.server);
    }
  },
);

test('a synchronous private startup failure removes its never-started owned directory', async () => {
  let paths: DaemonPaths | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    paths = resolveDaemonPaths(String(options?.env?.AGENT_DEVICE_STATE_DIR));
    throw new Error('cannot launch fixture');
  });
  await assert.rejects(
    sendToDaemon({ session: 'default', command: 'test', positionals: [], flags: {} }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.kind, 'daemon_startup_failed');
      const cleanup = error.details?.cleanupResults;
      assert.ok(Array.isArray(cleanup));
      assert.equal(cleanup[0]?.removedStateDir, true);
      return true;
    },
  );
  assert.ok(paths);
  assert.equal(fs.existsSync(paths.baseDir), false);
  assert.equal(spawn.mock.calls.length, 1);
});

test.for(['early exit', 'timeout'] as const)(
  'a private startup $0 retires its owned directory after joining the child',
  async (failure) => {
    let paths: DaemonPaths | undefined;
    let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
    let now = Date.now();
    let advanced = false;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    spawn.mockImplementation((_command, _args, options) => {
      paths = resolveDaemonPaths(String(options?.env?.AGENT_DEVICE_STATE_DIR));
      fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
      child = spawnRegisteredDaemonFixture(paths, fields(1), options);
      return child;
    });
    pause.mockImplementation(async (ms) => {
      if (advanced) {
        now += ms;
        return;
      }
      assert.ok(paths && child);
      await awaitFile(path.join(paths.baseDir, 'registration-held'));
      if (failure === 'early exit') {
        process.kill(child.pid, 'SIGTERM');
        await child.exited;
        now += 14_999;
      } else now += 15_000;
      advanced = true;
    });
    await assert.rejects(
      sendToDaemon({ session: 'default', command: 'test', positionals: [], flags: {} }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.kind, 'daemon_startup_failed');
        const cleanup = error.details?.cleanupResults as Array<{
          status: string;
          removedStateDir?: boolean;
        }>;
        assert.equal(cleanup[0]?.status, 'retired');
        assert.equal(cleanup[0]?.removedStateDir, true);
        return true;
      },
    );
    assert.ok(paths && child);
    await child.exited;
    assert.equal(isProcessAlive(child.pid), false);
    assert.equal(fs.existsSync(paths.baseDir), false);
    assert.equal(spawn.mock.calls.length, 1);
  },
);

for (const command of ['devices', 'test']) {
  test(`a joined busy contender adopts a real winner for ${command}`, async (t) => {
    if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-winner-'));
    const http = await startHttpDaemonFixture({ devices: [] });
    const deferred = path.join(paths.baseDir, 'defer-publication');
    fs.writeFileSync(deferred, 'wait');
    const winner = spawnRegisteredDaemonFixture(paths, fields(http.port), { stdio: 'ignore' });
    await awaitFile(path.join(paths.baseDir, 'registration-held'));
    fs.writeFileSync(
      paths.infoPath,
      JSON.stringify({ ...fields(http.port, '0.0.1'), pid: 999_999_999, processStartTime: 'old' }),
    );
    let joined = false;
    let genuineExit: ExecDetachedExit | undefined;
    let contender: ReturnType<typeof runCmdDetachedMonitored> | undefined;
    let releaseJoin: (exit: ExecDetachedExit) => void = () => {};
    let pauses = 0;
    spawn.mockImplementation((_command, _args, options) => {
      contender = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
      void contender.exited.then((exit) => {
        assert.equal(exit.exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
        genuineExit = exit;
      });
      return {
        ...contender,
        exited: new Promise((resolve) => {
          releaseJoin = resolve;
        }),
      };
    });
    pause.mockImplementation(async (ms) => {
      pauses += 1;
      fs.rmSync(deferred, { force: true });
      await awaitFile(paths.infoPath);
      await actualRetry.sleep(ms);
      if (pauses >= 2 && genuineExit) {
        joined = true;
        releaseJoin(genuineExit);
      }
    });
    try {
      const response = await sendToDaemon(request(paths, command));
      assert.equal(response.ok, true);
      assert.equal(joined, true);
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(http.rpcRequests.length, 1);
      assert.equal(isProcessAlive(winner.pid), true);
      const claim = inspectProcessLock(paths.lockPath);
      assert.equal(claim.state, 'held');
      if (claim.state === 'held') assert.equal(claim.owner.pid, winner.pid);
    } finally {
      if (contender) releaseJoin(await contender.exited);
      await closeLoopbackServer(http.server);
    }
  });
}

test('a client-held claim is waited out before a fresh daemon attempt', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-client-holder-'));
  const http = await startHttpDaemonFixture({ devices: [] });
  const claim = tryAcquireProcessLock({
    lockDirPath: paths.lockPath,
    owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
  });
  assert.equal(claim.status, 'acquired');
  if (claim.status !== 'acquired') throw new Error('fixture claim refused');
  let loserJoined = false;
  let released = false;
  spawn.mockImplementation((_command, _args, options) => {
    const child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    if (spawn.mock.calls.length === 1)
      void child.exited.then((exit) => {
        assert.equal(exit.exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
        loserJoined = true;
      });
    else assert.equal(loserJoined, true);
    return child;
  });
  pause.mockImplementation(async (ms) => {
    if (loserJoined && !released) {
      await claim.acquisition.release();
      released = true;
    }
    await actualRetry.sleep(ms);
  });
  try {
    assert.equal((await sendToDaemon(request(paths))).ok, true);
    assert.equal(spawn.mock.calls.length, 2);
    assert.equal(http.rpcRequests.length, 1);
  } finally {
    if (!released) await claim.acquisition.release();
    await closeLoopbackServer(http.server);
  }
});

for (const exit of [
  { exitCode: 0 },
  { exitCode: 1 },
  { exitCode: DAEMON_STARTUP_EXIT_CODES.unproven },
  { exitCode: DAEMON_STARTUP_EXIT_CODES.busy, error: 'spawn refused' },
  { exitCode: DAEMON_STARTUP_EXIT_CODES.busy, signal: 'SIGTERM' as const },
]) {
  test(`generic exit ${exit.error ?? exit.signal ?? exit.exitCode} cannot adopt or stop a foreign winner`, async (t) => {
    if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-generic-exit-'));
    const http = await startHttpDaemonFixture({ devices: [] });
    const deferred = path.join(paths.baseDir, 'defer-publication');
    fs.writeFileSync(deferred, 'wait');
    const winner = spawnRegisteredDaemonFixture(paths, fields(http.port), { stdio: 'ignore' });
    await awaitFile(path.join(paths.baseDir, 'registration-held'));
    spawn.mockImplementation(() => ({
      pid: 999_999,
      exited: Promise.resolve({ pid: 999_999, ...exit }),
    }));
    pause.mockImplementation(async (ms) => {
      fs.rmSync(deferred, { force: true });
      await actualRetry.sleep(ms);
    });
    try {
      await assert.rejects(
        sendToDaemon(request(paths)),
        (error: unknown) =>
          error instanceof AppError && error.details?.kind === 'daemon_startup_failed',
      );
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(http.rpcRequests.length, 0);
      assert.equal(isProcessAlive(winner.pid), true);
      assert.equal(inspectProcessLock(paths.lockPath).state, 'held');
    } finally {
      await closeLoopbackServer(http.server);
    }
  });
}

test('a joined busy contender waits for a published winner to become ready without signaling it', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-delayed-ready-'));
  let probes = 0;
  const http = await startHttpDaemonFixture({ devices: [] }, { ready: () => ++probes >= 12 });
  const deferred = path.join(paths.baseDir, 'defer-publication');
  fs.writeFileSync(deferred, 'wait');
  const winner = spawnRegisteredDaemonFixture(paths, fields(http.port), { stdio: 'ignore' });
  await awaitFile(path.join(paths.baseDir, 'registration-held'));
  let contenderExit: ExecDetachedExit | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    const child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    void child.exited.then((exit) => {
      contenderExit = exit;
    });
    return child;
  });
  pause.mockImplementation(async () => {
    if (contenderExit) fs.rmSync(deferred, { force: true });
    await actualRetry.sleep(10);
  });
  const signal = vi.spyOn(process, 'kill');
  try {
    assert.equal((await sendToDaemon(request(paths))).ok, true);
    assert.equal(contenderExit?.exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
    assert.ok(probes >= 12);
    assert.equal(spawn.mock.calls.length, 1);
    assert.equal(http.rpcRequests.length, 1);
    assert.equal(isProcessAlive(winner.pid), true);
    assert.equal(
      signal.mock.calls.some(([pid, kind]) => pid === winner.pid && kind !== 0),
      false,
    );
  } finally {
    signal.mockRestore();
    await closeLoopbackServer(http.server);
  }
});

for (const held of [true, false]) {
  test(`startup uses one deadline when the claim is ${held ? 'held' : 'released for relaunch'}`, async () => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-budget-'));
    const claim = tryAcquireProcessLock({
      lockDirPath: paths.lockPath,
      owner: { ...readCurrentOwnerIdentity(), acquiredAtMs: Date.now() },
    });
    assert.equal(claim.status, 'acquired');
    if (claim.status !== 'acquired') throw new Error('fixture claim refused');
    let now = Date.now();
    const started = now;
    let released = false;
    let advanced = false;
    let finishPending: () => void = () => {};
    const nativeTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) =>
      nativeTimeout(handler, ms === 1_000 ? 0 : ms, ...args),
    );
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    spawn.mockImplementation(() => ({
      pid: 999_999,
      exited:
        spawn.mock.calls.length === 1
          ? Promise.resolve({ pid: 999_999, exitCode: DAEMON_STARTUP_EXIT_CODES.busy })
          : new Promise<ExecDetachedExit>((resolve) => {
              finishPending = () => resolve({ pid: 999_999, exitCode: 1 });
            }),
    }));
    pause.mockImplementation(async (ms) => {
      if (!advanced) {
        if (!held) {
          await claim.acquisition.release();
          released = true;
        }
        advanced = true;
        now += 14_750;
      } else now += ms;
    });
    try {
      await assert.rejects(sendToDaemon(request(paths)), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.startupAttempts, held ? 1 : 2);
        assert.equal(error.details?.startupTimeoutMs, 15_000);
        return true;
      });
      assert.equal(now - started, 15_000);
      assert.equal(inspectProcessLock(paths.lockPath).state, held ? 'held' : 'absent');
    } finally {
      finishPending();
      vi.restoreAllMocks();
      if (!released) await claim.acquisition.release();
    }
  });
}

test.for([
  { budget: 'ample', offset: 0, launches: 2, alive: false, rpcs: 1 },
  { budget: 'near deadline', offset: 11_000, launches: 1, alive: true, rpcs: 0 },
])('an older winner is replaced only with enough startup time ($budget)', async (expected, t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-older-winner-'));
  const http = await startHttpDaemonFixture({ devices: [] });
  const deferred = path.join(paths.baseDir, 'defer-publication');
  fs.writeFileSync(deferred, 'wait');
  const winner = spawnRegisteredDaemonFixture(paths, fields(http.port, '0.0.1'), {
    stdio: 'ignore',
  });
  await awaitFile(path.join(paths.baseDir, 'registration-held'));
  const wallTime = Date.now;
  let offset = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => wallTime() + offset);
  let joined = false;
  spawn.mockImplementation((_command, _args, options) => {
    if (spawn.mock.calls.length > 1) assert.equal(joined, true);
    const child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    if (spawn.mock.calls.length === 1)
      void child.exited.then((exit) => {
        assert.equal(exit.exitCode, DAEMON_STARTUP_EXIT_CODES.busy);
        joined = true;
      });
    return child;
  });
  pause.mockImplementation(async (ms) => {
    if (joined) {
      fs.rmSync(deferred, { force: true });
      if (expected.offset) offset = offset ? offset + ms : expected.offset;
    }
    await actualRetry.sleep(10);
  });
  const notice = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const pending = sendToDaemon(request(paths));
    if (expected.alive)
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.kind, 'daemon_startup_failed');
        assert.equal(error.details?.startupAttempts, 1);
        assert.equal(error.details?.startupTimeoutMs, 15_000);
        return true;
      });
    else {
      assert.equal((await pending).ok, true);
      await winner.exited;
    }
    assert.equal(joined, true);
    assert.equal(isProcessAlive(winner.pid), expected.alive);
    assert.equal(spawn.mock.calls.length, expected.launches);
    assert.equal(http.rpcRequests.length, expected.rpcs);
    assert.equal(
      notice.mock.calls.flat().join('').includes(`Replacing daemon (pid ${winner.pid}, v0.0.1)`),
      !expected.alive,
    );
  } finally {
    clock.mockRestore();
    notice.mockRestore();
    await closeLoopbackServer(http.server);
  }
});

test('a failed own transport probe retires and joins the private startup before rejecting', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  const http = await startHttpDaemonFixture({ devices: [] });
  let paths: DaemonPaths | undefined;
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  let failure: AppError | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    paths = resolveDaemonPaths(String(options?.env?.AGENT_DEVICE_STATE_DIR));
    child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    return child;
  });
  pause.mockImplementation(actualRetry.sleep);
  try {
    await assert.rejects(
      sendToDaemon({
        session: 'default',
        command: 'test',
        positionals: [],
        flags: { daemonTransport: 'socket', daemonServerMode: 'http' },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'Daemon socket endpoint is unavailable');
        assert.equal(error.details?.reason, 'daemon_endpoint_unavailable');
        failure = error;
        return true;
      },
    );
    assert.ok(paths && child && failure);
    assert.equal(isProcessAlive(child.pid), false);
    assert.equal(fs.existsSync(paths.baseDir), false);
    await child.exited;
    assert.equal(failure.details?.startupJoined, true);
    assert.equal(failure.details?.stateDir, paths.baseDir);
    const results = failure.details?.cleanupResults as Array<{
      status: string;
      removedStateDir?: boolean;
    }>;
    assert.equal(results[0]?.status, 'retired');
    assert.equal(results[0]?.removedStateDir, true);
    assert.equal(http.rpcRequests.length, 0);
  } finally {
    await closeLoopbackServer(http.server);
  }
});

test.for(['default', 'private replay'] as const)(
  'a missed initial birth probe recovers the monitored child for $0',
  async (route, t) => {
    if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
    const http = await startHttpDaemonFixture({ devices: [], sessionActive: false });
    const defaultPaths = resolveDaemonPaths(mkdtempForTestSync('daemon-missed-birth-'));
    const ensure = vi.spyOn(lifecycle, 'ensureDaemon');
    let paths: DaemonPaths | undefined;
    let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    spawn.mockImplementation((_command, _args, options) => {
      paths = resolveDaemonPaths(String(options?.env?.AGENT_DEVICE_STATE_DIR));
      child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
      vi.mocked(readProcessStartTime).mockReturnValueOnce(null);
      return child;
    });
    pause.mockImplementation(async () => {
      assert.ok(paths);
      if (http.rpcRequests.length === 0) {
        await awaitFile(paths.infoPath);
        now += 1_000;
      } else {
        await actualRetry.sleep(10);
        now += 10;
      }
    });
    try {
      const response = await sendToDaemon(
        route === 'default'
          ? request(defaultPaths)
          : { session: 'default', command: 'replay', positionals: [], flags: {} },
      );
      assert.equal(response.ok, true);
      assert.equal(ensure.mock.calls.length, 1);
      assert.equal((await ensure.mock.results[0]!.value).startedByClient, true);
      assert.equal(spawn.mock.calls.length, 1);
      assert.equal(http.rpcRequests.length, 1);
      assert.ok(paths && child);
      if (route === 'private replay') {
        await child.exited;
        assert.equal(isProcessAlive(child.pid), false);
        assert.equal(fs.existsSync(paths.baseDir), false);
      } else {
        assert.equal(isProcessAlive(child.pid), true);
        assert.equal(inspectProcessLock(paths.lockPath).state, 'held');
        assert.equal(fs.existsSync(paths.infoPath), true);
      }
    } finally {
      await closeLoopbackServer(http.server);
    }
  },
);
