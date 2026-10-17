// #3782: the local-daemon startup budget. A live daemon that starts slowly is waited for; a
// daemon that exits is failed fast; a live daemon that publishes no startup progress is retired at
// the stall window, not at the ceiling; and the ceiling itself is operator-settable. These cases
// pin each outcome at the `sendToDaemon` transport boundary, the route CLI, MCP, and Node share.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { ExecDetachedExit } from '@agent-device/host-kit/command';
import {
  DAEMON_STARTUP_EXIT_CODES,
  recordDaemonStartupMarker,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
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
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { sendToDaemon } from '../daemon-client.ts';

const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const spawn = vi.mocked(runCmdDetachedMonitored);
const pause = vi.mocked(sleep);

afterEach(async () => {
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

/**
 * A registered-fixture daemon with deferred publication: it acquires the registration, publishes
 * no daemon.json, and never exits on its own — the startup the client must judge from process
 * liveness and startup markers alone. Its command matches the daemon identity rules, so the
 * client's retirement signals it and it exits, keeping each test's fixtures disposable.
 */
function spawnUnregisteredDaemonChild(
  paths: DaemonPaths,
  options: Parameters<typeof runCmdDetachedMonitored>[2],
  emitStartupMarker = false,
): ReturnType<typeof runCmdDetachedMonitored> {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  // When asked, the child records its phases through the real protocol, into the file named for
  // its own pid, exactly as the daemon entry does. The request is bound into this child's entry
  // script, so no later fixture in this state dir inherits it.
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

/** Waits (on the unmocked clock) for one line of the client's own sleep seam. */
async function realPause(ms = 5) {
  await actualRetry.sleep(ms);
}

async function awaitFile(file: string) {
  for (let attempt = 0; !fs.existsSync(file); attempt += 1) {
    assert.ok(attempt < 400, `fixture did not publish ${file}`);
    await actualRetry.sleep(10);
  }
}

test('a daemon slower than the retired 15 s budget starts successfully while it keeps progressing', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback unavailable');
  const http = await startHttpDaemonFixture({ devices: [] });
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-slow-success-'));
  // Virtual time: the client waits ~20 s of startup — past the retired 15 s deadline — in real
  // milliseconds. The clock stands still while the real fixture child is still booting (marker
  // timestamps must come from this launch), and a progress marker every ~6 virtual seconds keeps
  // the wait outside the 60 s stall window. Markers go to this launch's own pid-named file, which
  // is where a real daemon writes them.
  const startedAt = Date.now();
  const now = { value: startedAt };
  vi.spyOn(Date, 'now').mockImplementation(() => now.value);
  const spawned = { at: 0, child: undefined as { pid: number } | undefined };
  let booted = false;
  spawn.mockImplementation((_command, _args, options) => {
    const child = spawnRegisteredDaemonFixture(paths, fields(http.port), options);
    spawned.at = now.value;
    spawned.child = child;
    return child;
  });
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  let polls = 0;
  pause.mockImplementation(async () => {
    polls += 1;
    if (!booted) {
      booted = fs.existsSync(path.join(paths.baseDir, 'registration-held'));
      if (!booted) return await realPause();
    }
    if (now.value - spawned.at < 20_000) {
      now.value += 2_000;
      if (polls % 3 === 0 && spawned.child)
        recordDaemonStartupMarker(
          resolveDaemonStartupPhasesPath(paths.baseDir, spawned.child.pid),
          'lock-acquired',
        );
      if (now.value - spawned.at >= 20_000)
        fs.rmSync(path.join(paths.baseDir, 'defer-publication'), { force: true });
      return await realPause();
    }
    // The client has waited past the retired 15 s budget; hold the virtual clock while the real
    // child notices the lifted barrier and publishes, polling at full real speed.
    await realPause(20);
  });
  try {
    const response = await sendToDaemon(request(paths));
    assert.equal(response.ok, true);
    assert.ok(
      now.value - spawned.at >= 20_000,
      'the startup this test proves must exceed the retired 15 s budget',
    );
    assert.equal(spawn.mock.calls.length, 1);
    assert.equal(http.rpcRequests.length, 1);
    assert.ok(spawned.child && isProcessAlive(spawned.child.pid), 'the client must not retire it');
  } finally {
    await closeLoopbackServer(http.server);
  }
});

test('a daemon that exits during startup fails with startup-exited within one second of the exit', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-exit-fast-'));
  let resolveFirstExit: ((exit: ExecDetachedExit) => void) | undefined;
  let exitObservedAt = 0;
  spawn.mockImplementation(() => {
    // Fabricated pid: the retirement path proves daemon identity through the process table, finds
    // no such process, and signals nothing.
    const pid = 998_231 + spawn.mock.calls.length;
    if (spawn.mock.calls.length === 1) {
      // The exit arrives ~400 ms of real time after the spawn: the client must observe the
      // monitor and report within its one-second detection budget.
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
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '120000');
  const started = Date.now();
  const now = { value: started };
  vi.spyOn(Date, 'now').mockImplementation(() => now.value);
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-no-marker-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  spawn.mockImplementation((_command, _args, options) => {
    child = spawnUnregisteredDaemonChild(paths, options);
    return child;
  });
  let booted = false;
  pause.mockImplementation(async () => {
    if (!booted) {
      booted = fs.existsSync(path.join(paths.baseDir, 'registration-held'));
      if (!booted) return await realPause();
    }
    // Advance the virtual clock to the stall window; freeze it afterward so the real-time
    // retirement below cannot stretch the measured detection past it.
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
    // #3782 residue rule: the retired launch's exit was joined, so its marker file is removed —
    // a startup the client owned must leave no evidence behind. The prefix check is name-agnostic
    // so no marker-file shape can pass by accident.
    await (child?.exited ?? Promise.resolve());
    assert.deepEqual(
      fs.readdirSync(paths.baseDir).filter((entry) => entry.startsWith('daemon-startup-phases')),
      [],
      'a joined startup must sweep its own phase-marker file',
    );
  } finally {
    await (child?.exited ?? Promise.resolve());
  }
});

test('a live daemon that keeps progressing but never registers fails at the env ceiling with phases', async () => {
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const started = Date.now();
  const now = { value: started };
  vi.spyOn(Date, 'now').mockImplementation(() => now.value);
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-ceiling-'));
  let child: ReturnType<typeof runCmdDetachedMonitored> | undefined;
  let booted = false;
  const spawned = { at: 0 };
  spawn.mockImplementation((_command, _args, options) => {
    child = spawnUnregisteredDaemonChild(paths, options, true);
    spawned.at = now.value;
    return child;
  });
  let polls = 0;
  pause.mockImplementation(async () => {
    polls += 1;
    if (!booted) {
      booted = fs.existsSync(path.join(paths.baseDir, 'registration-held'));
      if (!booted) return await realPause();
    }
    // The real child has published its own `lock-acquired` marker: progress this wait keeps
    // extending is the daemon's, not the test's. Virtual time advances 1 s per poll; the 30 s
    // env ceiling stops the wait well before the 60 s stall window can.
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
  // F1 (#3782): a reused state dir still holds the phase record a dead earlier startup wrote. The
  // fresh launch records its own progress through the real protocol, from its own process. The
  // shared-record reader kept the earliest occurrence per phase, so the older record hid the fresh
  // launch's `lock-acquired` from the failure details entirely — the exact loss of attribution that
  // turns a progressing startup into an empty observation and a false stall. The state dir must
  // also sweep what its own launches leave behind.
  vi.stubEnv('AGENT_DEVICE_DAEMON_STARTUP_TIMEOUT_MS', '30000');
  const paths = resolveDaemonPaths(mkdtempForTestSync('daemon-start-stale-history-'));
  fs.mkdirSync(paths.baseDir, { recursive: true });
  // The leftover launch: a real daemon-shaped child that records its phase, is SIGTERMed before
  // publishing, and leaves its record behind exactly as a crashed startup would.
  fs.writeFileSync(path.join(paths.baseDir, 'defer-publication'), 'wait');
  const leftover = spawnRegisteredDaemonFixture(paths, fields(1), { stdio: 'ignore' }, undefined, {
    emitStartupMarker: true,
  });
  await awaitFile(registrationHeldFor(paths, leftover.pid));
  process.kill(leftover.pid, 'SIGTERM');
  await leftover.exited;
  const leftoverRecords = () =>
    fs.readdirSync(paths.baseDir).filter((entry) => entry.startsWith('daemon-startup-phases'));
  assert.ok(
    leftoverRecords().length > 0,
    'the leftover launch must have left a real daemon-written marker record',
  );

  const started = Date.now();
  const now = { value: started };
  vi.spyOn(Date, 'now').mockImplementation(() => now.value);
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
    // The 30 s env ceiling stops this wait before the 60 s stall window can; the fresh child's own
    // `lock-acquired` marker is the only progress evidence and must reach the failure record.
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
      !leftoverRecords().some((entry) => entry.includes(String(child?.pid))),
      "the joined exit must sweep this launch's own marker file",
    );
    // A dead launch's record that survived every sweep so far: written through the real protocol
    // against a provably dead pid after the fresh launch's own acquisition sweep, so only the next
    // registration owner can remove it.
    recordDaemonStartupMarker(resolveDaemonStartupPhasesPath(paths.baseDir, 998_776), 'listening');
    const cleaner = spawnRegisteredDaemonFixture(paths, fields(1), { stdio: 'ignore' });
    try {
      await awaitFile(registrationHeldFor(paths, cleaner.pid));
      assert.deepEqual(
        leftoverRecords(),
        [],
        "acquiring the registration sweeps every dead launch's marker record",
      );
    } finally {
      process.kill(cleaner.pid, 'SIGTERM');
      await cleaner.exited;
    }
  } finally {
    // The client's own retirement (or the sweep test's SIGTERM) already stopped this child; the
    // hermetic signal guard refuses any signal the worker did not need to send.
    await (child?.exited ?? Promise.resolve());
  }
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
