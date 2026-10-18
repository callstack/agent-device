import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { ExecDetachedExit } from '@agent-device/host-kit/command';
import { DAEMON_STARTUP_EXIT_CODES } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  readDaemonStartupPhaseMarkers,
  recordDaemonStartupMarker,
  resolveDaemonStartupPhasesPath,
  type DaemonStartupPhase,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  closeLoopbackServer,
  mkdtempForTestSync,
  supportsLoopbackBind,
} from '@agent-device/test-kit';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import {
  spawnRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
  waitForFixtureFile,
} from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  startHttpDaemonFixture,
  currentDaemonCodeSignature,
} from '../../__tests__/test-utils/daemon-http-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(),
}));
// A pinned fabricated pid answers the signal-0 probe from this map; afterEach drops the map.
let livenessOverrides: Map<number, boolean> | undefined;
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    isProcessAlive: (pid: number) => livenessOverrides?.get(pid) ?? actual.isProcessAlive(pid),
  };
});
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { sendToDaemon } from '../daemon-client.ts';

const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const spawn = vi.mocked(runCmdDetachedMonitored);
const pause = vi.mocked(sleep);

afterEach(async () => {
  livenessOverrides = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function fields(httpPort: number) {
  return {
    httpPort,
    token: 'secret',
    version: readVersion(),
    codeOrigin: 'checkout' as const,
    codeSignature: currentDaemonCodeSignature(),
  };
}

/** A deferred-publication fixture that never exits on its own; retirement can still stop it. */
function spawnUnregisteredDaemonChild(
  paths: DaemonPaths,
  options: Parameters<typeof runCmdDetachedMonitored>[2],
  emitStartupMarker = false,
): ReturnType<typeof runCmdDetachedMonitored> {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  return spawnRegisteredDaemonFixture(paths, fields(1), options, undefined, { emitStartupMarker });
}

function registrationHeldFor(paths: DaemonPaths, pid: number): string {
  return path.join(paths.baseDir, `registration-held-${pid}`);
}

async function expectStartupFailure(pending: Promise<unknown>): Promise<AppError> {
  let thrown: AppError | undefined;
  try {
    await pending;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    thrown = error;
  }
  assert.ok(thrown, 'expected the startup to reject');
  assert.equal(thrown.message, 'Failed to start daemon');
  assert.equal(thrown.details?.kind, 'daemon_startup_failed');
  return thrown;
}

function startupPhases(failure: AppError): Record<string, number> {
  assert.ok(
    failure.details?.phases && typeof failure.details.phases === 'object',
    'startup failure must record the phase timings it observed',
  );
  return failure.details.phases as Record<string, number>;
}

async function realPause(ms = 5) {
  await actualRetry.sleep(ms);
}

/** Pins `Date.now` to a mutable value: advancing the wait costs no real time. */
function virtualClock(): { value: number } {
  const now = { value: Date.now() };
  vi.spyOn(Date, 'now').mockImplementation(() => now.value);
  return now;
}

/** The startup phase records left in this state dir, by file name. */
function phaseRecordEntries(paths: DaemonPaths): string[] {
  return fs.readdirSync(paths.baseDir).filter((entry) => entry.startsWith('daemon-startup-phases'));
}

function registrationBooted(paths: DaemonPaths): () => boolean {
  let booted = false;
  return () => (booted ||= fs.existsSync(path.join(paths.baseDir, 'registration-held')));
}

test('a daemon slower than the retired 15 s budget starts successfully while it keeps progressing', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '150000');
  const http = await startHttpDaemonFixture({ devices: [] });
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-slow-success-'));
  // The success must rest on the markers: four successive phases 20 s apart across 80 s of virtual
  // time under a 150 s ceiling keep progress inside the 60 s stall window; the same span with no
  // readable markers fails as startup-stalled, one rewritten phase never advances progress.
  const phases: readonly DaemonStartupPhase[] = [
    'modules-loaded',
    'composition-loaded',
    'lock-acquired',
    'recovery-finished',
  ];
  const now = virtualClock();
  const spawned = { at: 0, child: undefined as { pid: number } | undefined };
  const booted = registrationBooted(paths);
  spawn.mockImplementation((_command, _args, options) => {
    const child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    spawned.at = now.value;
    spawned.child = child;
    return child;
  });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  let nextPhase = 0;
  pause.mockImplementation(async () => {
    if (!booted()) return await realPause();
    if (spawned.child && now.value - spawned.at < 80_000) {
      now.value += 20_000;
      if (nextPhase < phases.length) {
        recordDaemonStartupMarker(
          resolveDaemonStartupPhasesPath(paths.baseDir, spawned.child.pid),
          phases[nextPhase]!,
        );
        nextPhase += 1;
      }
      if (nextPhase === phases.length)
        fs.rmSync(path.join(paths.baseDir, 'defer-publication'), { force: true });
      return await realPause();
    }
    await realPause(20);
  });
  try {
    const response = await sendToDaemon(request(paths));
    assert.equal(response.ok, true);
    assert.ok(now.value - spawned.at >= 60_000, 'this startup must outlast the stall window');
    assert.equal(spawn.mock.calls.length, 1);
    assert.equal(http.rpcRequests.length, 1);
    assert.ok(spawned.child && isProcessAlive(spawned.child.pid), 'the client must not retire it');
    // The wait survived on four distinct phases, not one repeated marker.
    const markers = readDaemonStartupPhaseMarkers(
      fs.readFileSync(resolveDaemonStartupPhasesPath(paths.baseDir, spawned.child!.pid), 'utf8'),
    );
    for (const phase of phases) {
      assert.equal(typeof markers[phase], 'number', `the ${phase} phase was never observed`);
    }
  } finally {
    await closeLoopbackServer(http.server);
  }
});

test('a daemon that exits during startup fails with startup-exited within one second of the exit', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-exit-fast-'));
  let resolveFirstExit: ((exit: ExecDetachedExit) => void) | undefined;
  let exitObservedAt = 0;
  spawn.mockImplementation(() => {
    const pid = 998_231 + spawn.mock.calls.length;
    if (spawn.mock.calls.length === 1) {
      const exited = new Promise<ExecDetachedExit>((resolve) => {
        resolveFirstExit = resolve;
      });
      void exited.then(() => {
        exitObservedAt = Date.now();
      });
      setTimeout(() => resolveFirstExit?.({ pid, exitCode: 1 }), 400);
      return { pid, exited };
    }
    return { pid, exited: Promise.resolve({ pid, exitCode: 1 }) };
  });
  pause.mockImplementation(async (ms) => {
    await realPause(Math.min(Number(ms), 50));
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.ok(exitObservedAt > 0, 'the fixture must have delivered the exit');
  assert.ok(Date.now() - exitObservedAt <= 1_000, 'the failure must follow the exit within 1 s');
});

test('a live daemon that publishes no startup marker is retired as stalled before the ceiling', async () => {
  // Unsets the variable, even when the host exports it: the resolved ceiling must be the default.
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', undefined);
  const now = virtualClock();
  const started = now.value;
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-no-marker-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    child = spawnUnregisteredDaemonChild(paths, options);
    return child;
  });
  const booted = registrationBooted(paths);
  pause.mockImplementation(async () => {
    if (!booted()) return await realPause();
    if (now.value - started < 70_000) now.value += 5_000;
    await realPause();
  });
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    const elapsed = now.value - started;
    assert.equal(failure.details?.reason, 'startup-stalled');
    assert.ok(
      elapsed >= 60_000 && elapsed < 75_000,
      `a stall must retire the daemon at the stall window, not the ceiling (${elapsed}ms)`,
    );
    assert.equal(failure.details?.startupTimeoutMs, 120_000);
    assert.equal(startupPhases(failure).spawned, 0);
    assert.match(String(failure.details?.hint), /AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS/);
    assert.equal(spawn.mock.calls.length, 1, 'a stalled daemon is not retried');
    await (child?.exited ?? Promise.resolve());
    assert.deepEqual(
      phaseRecordEntries(paths),
      [],
      'a joined startup must sweep its own phase-marker file',
    );
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test('a live daemon that keeps progressing but never registers fails at the env ceiling with phases', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const now = virtualClock();
  const started = now.value;
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-ceiling-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  const booted = registrationBooted(paths);
  spawn.mockImplementation((_command, _args, options) => {
    child = spawnUnregisteredDaemonChild(paths, options, true);
    return child;
  });
  pause.mockImplementation(async () => {
    if (!booted()) return await realPause();
    if (now.value - started < 30_000) now.value += 1_000;
    await realPause();
  });
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    assert.equal(failure.details?.reason, 'startup-ceiling');
    assert.equal(failure.details?.startupTimeoutMs, 30_000);
    const phases = startupPhases(failure);
    assert.equal(phases.spawned, 0);
    assert.ok(
      typeof phases['lock-acquired'] === 'number' &&
        phases['lock-acquired'] >= 0 &&
        phases['lock-acquired'] < 30_000,
      'the observed marker must be reported relative to the spawn',
    );
    assert.match(String(failure.details?.hint), /AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS/);
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test("a startup progressed by a fresh launch is not judged stalled by an earlier launch's leftover markers", async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-stale-history-'));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  const leftover = spawnRegisteredDaemonFixture(paths, fields(1), { stdio: 'ignore' }, undefined, {
    emitStartupMarker: true,
  });
  await waitForFixtureFile(registrationHeldFor(paths, leftover.pid));
  process.kill(leftover.pid, 'SIGTERM');
  await leftover.exited;
  assert.ok(
    phaseRecordEntries(paths).length > 0,
    'the leftover launch must have left a real daemon-written marker record',
  );
  const now = virtualClock();
  const started = now.value;
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  let booted = false;
  spawn.mockImplementation((_command, _args, options) => {
    child = spawnUnregisteredDaemonChild(paths, options, true);
    return child;
  });
  pause.mockImplementation(async () => {
    if (child && !booted) {
      booted = fs.existsSync(registrationHeldFor(paths, child.pid));
      if (!booted) return await realPause();
    }
    if (now.value - started < 30_000) now.value += 1_000;
    await realPause();
  });
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    assert.equal(failure.details?.reason, 'startup-ceiling');
    const phases = startupPhases(failure);
    assert.equal(
      typeof phases['lock-acquired'],
      'number',
      'the fresh launch must observe its own marker despite the older record',
    );
    await (child?.exited ?? Promise.resolve());
    assert.ok(
      !phaseRecordEntries(paths).some((entry) => entry.includes(String(child?.pid))),
      "the joined exit must sweep this launch's own marker file",
    );
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test('a busy exit while a live lock holder defers publication reaches the ceiling, not startup-exited', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '2000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-holder-ceiling-'));
  const deferred = path.join(paths.baseDir, 'defer-publication');
  fs.writeFileSync(deferred, 'wait');
  const winner = spawnRegisteredDaemonFixture(paths, fields(1), { stdio: 'ignore' }, undefined, {
    emitStartupMarker: true,
  });
  await waitForFixtureFile(registrationHeldFor(paths, winner.pid));
  let contender: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    contender = spawnRegisteredDaemonFixture(paths, fields(1), options, undefined, {
      emitStartupMarkerBeforeAcquisition: true,
    });
    return contender;
  });
  pause.mockImplementation(async () => {
    await realPause(20);
  });
  const signal = vi.spyOn(process, 'kill');
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    assert.equal(failure.details?.reason, 'startup-ceiling');
    assert.equal(failure.details?.startupTimeoutMs, 2_000);
    assert.match(String(failure.details?.hint), /AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS/);
    assert.equal(typeof startupPhases(failure)['modules-loaded'], 'number');
    assert.equal(isProcessAlive(winner.pid), true);
    assert.equal(
      signal.mock.calls.some(([pid, kind]) => pid === winner.pid && kind !== 0),
      false,
    );
    assert.ok(contender);
    assert.deepEqual(
      phaseRecordEntries(paths).sort(),
      [path.basename(resolveDaemonStartupPhasesPath(paths.baseDir, winner.pid))],
      'the exited contender record must be swept; only the live winner record may remain',
    );
  } finally {
    signal.mockRestore();
    fs.rmSync(deferred, { force: true });
    await (contender?.exited ?? Promise.resolve());
  }
});

test('a child gone at the deadline without an observed exit and no live startup fails exited', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '2000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-gone-at-deadline-'));
  livenessOverrides = new Map([[997_842, false]]);
  spawn.mockImplementation(() => ({
    pid: 997_842,
    exited: new Promise<ExecDetachedExit>(() => {}),
    readIdentity: () => ({ pid: 997_842, startTime: null }),
  }));
  pause.mockImplementation(async () => {
    await realPause(50);
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.equal(failure.details?.startupTimeoutMs, 2_000);
});

test('an observed exit on a reused launch pid is not a live startup at the deadline', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '2000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-reused-pid-exit-'));
  const reusedPid = 997_603;
  livenessOverrides = new Map([[reusedPid, true]]);
  let resolveExit: ((exit: ExecDetachedExit) => void) | undefined;
  spawn.mockImplementation(() => ({
    pid: reusedPid,
    exited: new Promise<ExecDetachedExit>((resolve) => {
      resolveExit = resolve;
    }),
    readIdentity: () => ({ pid: reusedPid, startTime: null }),
  }));
  const now = virtualClock();
  let advanced = false;
  pause.mockImplementation(async () => {
    if (!advanced) {
      advanced = true;
      now.value += 2_000;
      resolveExit?.({ pid: reusedPid, exitCode: DAEMON_STARTUP_EXIT_CODES.busy });
    }
    await realPause(20);
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.equal(failure.details?.startupTimeoutMs, 2_000);
  assert.equal(spawn.mock.calls.length, 1, 'the deadline had passed, so no second attempt started');
});

test('an unproven registration exit reports startup-exited even under a short env ceiling', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '2000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-exit-under-ceiling-'));
  spawn.mockImplementation(() => ({
    pid: 998_444,
    exited: Promise.resolve({ pid: 998_444, exitCode: DAEMON_STARTUP_EXIT_CODES.unproven }),
  }));
  pause.mockImplementation(async () => {
    await realPause();
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.equal(failure.details?.startupTimeoutMs, 2_000);
});

test('a startup ceiling that is not a positive integer is rejected before any daemon spawns', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-bad-ceiling-'));
  for (const raw of ['0', '-5', 'abc', '12.5']) {
    vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', raw);
    await assert.rejects(
      sendToDaemon(request(paths)),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.message.includes('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS'),
    );
  }
  assert.equal(spawn.mock.calls.length, 0);
});
