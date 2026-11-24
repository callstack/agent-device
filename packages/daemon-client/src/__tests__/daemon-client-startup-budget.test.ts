import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { ExecDetachedExit } from '@agent-device/host-kit/command';
import { DAEMON_STARTUP_EXIT_CODES } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  parseDaemonStartupProgressMessage,
  type DaemonStartupPhase,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  closeLoopbackServer,
  mkdtempForTestSync,
  startHttpDaemonFixture,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { readVersion } from '@agent-device/host-kit/version';
import {
  spawnRegisteredDaemonFixture,
  planRegisteredDaemonLaunches,
  finishRegisteredDaemonFixtures,
  waitForFixtureFile,
} from './registered-daemon-fixture.ts';
import { currentDaemonCodeSignature } from './code-signature-fixture.ts';

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
import { sendToDaemon } from '../index.ts';

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
function unregisteredDaemonLaunch(paths: DaemonPaths, emitStartupPhase = false) {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  return {
    kind: 'registered' as const,
    paths,
    fields: fields(1),
    fixtureOptions: { emitStartupPhase },
  };
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

/**
 * Entries named like the marker files an older daemon version wrote. This client never creates,
 * reads, sweeps or removes one, so the only entries a start can leave behind are planted ones.
 */
function startupPhaseFileEntries(paths: DaemonPaths): string[] {
  return fs.readdirSync(paths.baseDir).filter((entry) => entry.startsWith('daemon-startup-phases'));
}

function registrationBooted(paths: DaemonPaths): () => boolean {
  let booted = false;
  return () => (booted ||= fs.existsSync(path.join(paths.baseDir, 'registration-held')));
}

test('a daemon slower than the retired 15 s budget starts successfully while it keeps reporting phases', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '150000');
  const http = await startHttpDaemonFixture({ devices: [] });
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-slow-success-'));
  // The success must rest on the channel phases: four successive phases 20 s apart across 80 s of
  // virtual time under a 150 s ceiling keep progress inside the 60 s stall window; the same span
  // with no reported phase fails as startup-stalled, and one repeated phase never advances progress.
  const phases: readonly DaemonStartupPhase[] = [
    'modules-loaded',
    'composition-loaded',
    'lock-acquired',
    'recovery-finished',
  ];
  const gate = path.join(paths.baseDir, 'emit-phase');
  const now = virtualClock();
  const spawned = { at: 0, child: undefined as { pid: number } | undefined };
  const reported: unknown[] = [];
  const booted = registrationBooted(paths);
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: fields(http.port),
        fixtureOptions: { emitPhaseFromGate: true },
        observe(child) {
          spawned.at = now.value;
          spawned.child = child;
          child.channel?.onMessage((message) => reported.push(message));
        },
      },
    ]),
  );
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  let nextPhase = 0;
  pause.mockImplementation(async () => {
    if (!booted()) return await realPause();
    if (spawned.child && now.value - spawned.at < 80_000) {
      now.value += 20_000;
      if (nextPhase < phases.length) {
        fs.writeFileSync(gate, phases[nextPhase]!);
        nextPhase += 1;
        // Wait for the child's real channel message before advancing the clock again, so each
        // receipt lands on the virtual time this pause just set.
        const expected = nextPhase;
        for (let attempt = 0; reported.length < expected && attempt < 400; attempt += 1)
          await realPause(5);
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
    // The wait survived on four distinct phases the child really sent over its own channel.
    const reportedPhases = reported.map((message) => parseDaemonStartupProgressMessage(message));
    for (const phase of phases) {
      assert.ok(reportedPhases.includes(phase), `the ${phase} phase was never reported`);
    }
    assert.deepEqual(
      startupPhaseFileEntries(paths),
      [],
      'a channel-reported start must not write any marker file',
    );
  } finally {
    await closeLoopbackServer(http.server);
  }
});

test('a daemon that exits during startup fails with startup-exited within one second of the exit', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-exit-fast-'));
  let resolveFirstExit: ((exit: ExecDetachedExit) => void) | undefined;
  let exitObservedAt = 0;
  const exitGate = new Promise<void>((resolve) => {
    resolveFirstExit = () => resolve();
  });
  void exitGate.then(() => {
    exitObservedAt = Date.now();
  });
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      () => {
        setTimeout(() => resolveFirstExit?.({ pid: 998_232, exitCode: 1 }), 400);
        return { kind: 'exit', exit: { pid: 998_232, exitCode: 1 }, exitGate };
      },
      { kind: 'exit', exit: { pid: 998_233, exitCode: 1 } },
    ]),
  );
  pause.mockImplementation(async (ms) => {
    await realPause(Math.min(Number(ms), 50));
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.ok(exitObservedAt > 0, 'the fixture must have delivered the exit');
  assert.ok(Date.now() - exitObservedAt <= 1_000, 'the failure must follow the exit within 1 s');
});

test('a live daemon that reports no startup phase is retired as stalled before the ceiling', async () => {
  // Unsets the variable, even when the host exports it: the resolved ceiling must be the default.
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', undefined);
  const now = virtualClock();
  const started = now.value;
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-no-marker-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      () => ({
        ...unregisteredDaemonLaunch(paths),
        observe(launched) {
          child = launched;
        },
      }),
    ]),
  );
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
      startupPhaseFileEntries(paths),
      [],
      'a channel-watched startup must not write any marker file',
    );
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test('a live daemon that keeps reporting phases but never registers fails at the env ceiling with phases', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const now = virtualClock();
  const started = now.value;
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-ceiling-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  const booted = registrationBooted(paths);
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      () => ({
        ...unregisteredDaemonLaunch(paths, true),
        observe(launched) {
          child = launched;
        },
      }),
    ]),
  );
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
      'the channel-reported phase must be reported relative to the spawn',
    );
    assert.match(String(failure.details?.hint), /AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS/);
    assert.deepEqual(startupPhaseFileEntries(paths), [], 'no marker file may be written');
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test("a startup progressed by its own channel is not judged by another launch's leftover marker file", async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-stale-history-'));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  // A leftover marker file an older daemon version wrote for a dead pid: it claims a phase this
  // launch never reports, so any phase the failure details carry must have come from the channel.
  const leftover = path.join(paths.baseDir, 'daemon-startup-phases-999999.jsonl');
  const leftoverContent = '{"data":{"startupPhase":"listening","timestampMs":1}}\n';
  fs.writeFileSync(leftover, leftoverContent);
  const now = virtualClock();
  const started = now.value;
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  let booted = false;
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      () => ({
        ...unregisteredDaemonLaunch(paths, true),
        observe(launched) {
          child = launched;
        },
      }),
    ]),
  );
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
      'the fresh launch must observe its own channel phase despite the older record',
    );
    assert.equal(
      phases['listening'],
      undefined,
      'a leftover marker file from another pid must never be read as progress',
    );
    await (child?.exited ?? Promise.resolve());
    assert.equal(
      fs.readFileSync(leftover, 'utf8'),
      leftoverContent,
      'the leftover record must be left byte-identical: never read, swept or removed',
    );
    assert.deepEqual(
      startupPhaseFileEntries(paths),
      [path.basename(leftover)],
      'only the planted leftover may remain; this start must add no marker file',
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
  // The winner is spawned without an IPC channel: its phase report is a no-op and writes nothing.
  const winner = spawnRegisteredDaemonFixture(paths, fields(1), { stdio: 'ignore' }, undefined, {
    emitStartupPhase: true,
  });
  await waitForFixtureFile(registrationHeldFor(paths, winner.pid));
  let contender: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: fields(1),
        fixtureOptions: { emitStartupPhaseBeforeAcquisition: true },
        observe(child) {
          contender = child;
        },
      },
    ]),
  );
  pause.mockImplementation(async () => {
    await realPause(20);
  });
  const signal = vi.spyOn(process, 'kill');
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    assert.equal(failure.details?.reason, 'startup-ceiling');
    assert.equal(failure.details?.startupTimeoutMs, 2_000);
    assert.match(String(failure.details?.hint), /AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS/);
    assert.equal(
      typeof startupPhases(failure)['modules-loaded'],
      'number',
      "the contender's own channel phase must be observed",
    );
    assert.equal(isProcessAlive(winner.pid), true);
    assert.equal(
      signal.mock.calls.some(([pid, kind]) => pid === winner.pid && kind !== 0),
      false,
    );
    assert.ok(contender);
    assert.deepEqual(
      startupPhaseFileEntries(paths),
      [],
      'neither the channel-less winner nor the contender may leave a marker file',
    );
  } finally {
    signal.mockRestore();
    fs.rmSync(deferred, { force: true });
    await (contender?.exited ?? Promise.resolve());
  }
});

test('a repeated phase message keeps the first receipt time', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-duplicate-phase-'));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  const gate = path.join(paths.baseDir, 'emit-phase');
  const now = virtualClock();
  const started = now.value;
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  const reported: unknown[] = [];
  const booted = registrationBooted(paths);
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      () => ({
        ...unregisteredDaemonLaunch(paths),
        fixtureOptions: { emitPhaseFromGate: true },
        observe(launched) {
          child = launched;
          launched.channel?.onMessage((message) => reported.push(message));
        },
      }),
    ]),
  );
  let sent = 0;
  pause.mockImplementation(async () => {
    if (!booted()) return await realPause();
    if (now.value - started < 30_000) {
      now.value += 1_000;
      const elapsed = now.value - started;
      if (elapsed === 1_000 || elapsed === 10_000) {
        fs.writeFileSync(gate, 'lock-acquired');
        sent += 1;
        for (let attempt = 0; reported.length < sent && attempt < 400; attempt += 1)
          await realPause(5);
      }
    }
    await realPause(20);
  });
  try {
    const failure = await expectStartupFailure(sendToDaemon(request(paths)));
    assert.equal(failure.details?.reason, 'startup-ceiling');
    assert.equal(reported.length, 2, 'the child must have sent the phase twice');
    assert.equal(
      startupPhases(failure)['lock-acquired'],
      1_000,
      'the duplicate must keep the first receipt time, not the latest',
    );
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test('a planted symlink named like an old marker file is never followed or modified by a full start', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const http = await startHttpDaemonFixture({ devices: [] });
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-symlink-'));
  const outsideDir = mkdtempForTestSync('daemon-start-symlink-outside-');
  const outside = path.join(outsideDir, 'outside.jsonl');
  const outsideContent = '{"data":{"startupPhase":"registered","timestampMs":1}}\n';
  fs.writeFileSync(outside, outsideContent);
  let planted = '';
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'registered',
        paths,
        fields: fields(http.port),
        observe(child) {
          // Plant the link under the spawned child's own pid, the name the old design would append to.
          planted = path.join(paths.baseDir, `daemon-startup-phases-${child.pid}.jsonl`);
          fs.symlinkSync(outside, planted);
        },
      },
    ]),
  );
  try {
    const response = await sendToDaemon(request(paths));
    assert.equal(response.ok, true);
    assert.equal(http.rpcRequests.length, 1);
    assert.ok(planted, 'the symlink must have been planted under the child pid');
    assert.equal(
      fs.readFileSync(outside, 'utf8'),
      outsideContent,
      'the planted link target must be byte-identical after the full start',
    );
    assert.equal(
      fs.lstatSync(planted).isSymbolicLink(),
      true,
      'the planted link must still be a link: never followed, replaced or removed',
    );
    assert.deepEqual(
      startupPhaseFileEntries(paths),
      [path.basename(planted)],
      'the only marker-named entry is the planted one; the start added none',
    );
  } finally {
    await closeLoopbackServer(http.server);
  }
});

test('a child gone at the deadline without an observed exit and no live startup fails exited', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '2000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-gone-at-deadline-'));
  livenessOverrides = new Map([[997_842, false]]);
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      { kind: 'exit', exit: { pid: 997_842 }, exitGate: new Promise(() => {}) },
    ]),
  );
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
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      {
        kind: 'exit',
        exit: { pid: reusedPid, exitCode: DAEMON_STARTUP_EXIT_CODES.busy },
        exitGate: new Promise<void>((resolve) => {
          resolveExit = () => resolve();
        }),
      },
    ]),
  );
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
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      { kind: 'exit', exit: { pid: 998_444, exitCode: DAEMON_STARTUP_EXIT_CODES.unproven } },
    ]),
  );
  pause.mockImplementation(async () => {
    await realPause();
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-exited');
  assert.equal(failure.details?.startupTimeoutMs, 2_000);
});

test('a listen-denied exit fails once with startup-listen-denied and a host-access hint', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-listen-denied-'));
  spawn.mockImplementation(
    planRegisteredDaemonLaunches([
      { kind: 'exit', exit: { pid: 998_555, exitCode: DAEMON_STARTUP_EXIT_CODES.listenDenied } },
      { kind: 'exit', exit: { pid: 998_556, exitCode: DAEMON_STARTUP_EXIT_CODES.listenDenied } },
    ]),
  );
  pause.mockImplementation(async () => {
    await realPause();
  });
  const failure = await expectStartupFailure(sendToDaemon(request(paths)));
  assert.equal(failure.details?.reason, 'startup-listen-denied');
  assert.match(String(failure.details?.hint), /listen EPERM or EACCES\). A sandbox/);
  assert.equal(spawn.mock.calls.length, 1, 'a denied listen is not retried');
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
