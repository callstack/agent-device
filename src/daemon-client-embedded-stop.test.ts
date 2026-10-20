// One stop, end to end: a runtime a host process owns, the record it publishes, and the stop an outside
// caller performs. The host here is the test process itself, which is what makes the strongest assertion
// in this file: a stop that ever reached for a signal would take the test runner down with it.

import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { startDaemonRuntime } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { stopDaemon } from '@agent-device/daemon-contracts/daemon-stop';
import {
  daemonShutdownCompletionAnswers,
  readDaemonShutdownRecord,
  resolveDaemonShutdownReportPath,
} from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { stopRecordedDaemon } from './daemon-client/daemon-client-stop.ts';
import { readDaemonInfo } from './daemon-client/daemon-client-metadata.ts';
import { sendRequest } from './daemon-client/daemon-client-transport.ts';
import * as transport from './daemon-client/daemon-client-transport.ts';
import * as processWait from '@agent-device/daemon-contracts/daemon-process';
import { AppError } from '@agent-device/kernel/errors';

const stopProbe = vi.hoisted(() => ({
  request: undefined as Promise<void> | undefined,
  owner: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  stopProbe.request = undefined;
  stopProbe.owner = undefined;
  stopProbe.entered = undefined;
});

vi.mock('./platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_context: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => [],
      finalizeDaemonShutdown: async () => [],
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {
      await stopProbe.owner;
      return [];
    },
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
}));

vi.mock('./provider-device-runtimes.ts', async () => ({
  createDaemonProviderRuntimeComposition: async () => ({
    runtimes: [],
    platformModules: [],
    // The composition is the one plugin-cleanup owner: its close answers with every plugin's outcomes.
    shutdown: async () => [],
    inventory: await (
      await import('./__tests__/test-utils/builtin-plugin-inventory.ts')
    ).builtinPluginInventory(),
  }),
}));

/**
 * A record whose owner field this build cannot place — the state a newer build's vocabulary, or a hand
 * edit, produces. A running runtime is never in this state: it always knows whether it owns itself, so
 * `unknown` is a reader's verdict about a file. The record is rewritten under a live runtime to produce
 * exactly that, with everything else about the instance left intact.
 */
async function bootRuntimeWithUnplaceableRecordOwner(ownership: 'embedded' | 'detached') {
  const booted = await bootRuntime(ownership);
  const record = JSON.parse(fs.readFileSync(booted.paths.infoPath, 'utf8')) as Record<
    string,
    unknown
  >;
  record.ownership = 'sideways';
  fs.writeFileSync(booted.paths.infoPath, JSON.stringify(record), { mode: 0o600 });
  expect(readDaemonStopIdentity(booted.paths.infoPath).ownership).toBe('unknown');
  return booted;
}

async function bootRuntime(ownership: 'embedded' | 'detached' = 'embedded') {
  const stateDir = mkdtempForTestSync('agent-device-embedded-stop-');
  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    }),
    ownership,
    shutdownBudgets: { requestDrainMs: 25, ownerMs: 25 },
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: async (input) => {
      const deps = await createDaemonRuntimeDeps(input);
      return {
        ...deps,
        requestRouter: {
          ...deps.requestRouter,
          providerDeviceRuntimeScope: async (task) => {
            if (stopProbe.request) {
              stopProbe.entered?.();
              await stopProbe.request;
            }
            return await task();
          },
        },
      };
    },
  });
  return { stateDir, paths: resolveDaemonPaths(stateDir), runtime };
}

/** The stop as the CLI performs it: read the record once, then route on what it states. */
function stopViaSocket(paths: ReturnType<typeof resolveDaemonPaths>) {
  return stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
    paths,
    host: createTestHostEnvironment(),
  });
}

/** A port that was bound and given back, so a request to it is refused rather than served. */
async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  const port = await listenOnLoopback(server);
  await closeLoopbackServer(server);
  return port;
}

/** The lifetime a record can name for a child that has only just been spawned. */
async function startTimeOf(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const startTime = readProcessStartTime(pid);
    if (startTime?.trim()) return startTime;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`child ${pid} never became readable`);
}

/**
 * The signals this stop sent at a process. `0` is the liveness probe and is not one; a `kill(pid)` with
 * no signal argument is SIGTERM, so an omitted signal counts as the signal it really is.
 */
function hostSignals(killSpy: { mock: { calls: Array<unknown[]> } }) {
  return killSpy.mock.calls.filter(([, signal]) => signal !== 0);
}

test('a host-owned runtime publishes the owner a stop has to respect', async () => {
  const { stateDir, paths, runtime } = await bootRuntime();
  try {
    const record = JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')) as {
      pid: number;
      ownership?: string;
    };
    // The record names the host's own process, which is why the signal path is closed here: stopping
    // this runtime means asking it, not ending the program that asked.
    expect(record.pid).toBe(process.pid);
    expect(record.ownership).toBe('embedded');
    expect(readDaemonStopIdentity(paths.infoPath).ownership).toBe('embedded');
    expect(readDaemonInfo(paths.infoPath)?.ownership).toBe('embedded');
  } finally {
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('stopping a host-owned runtime asks it to leave and reports what its close said', async () => {
  const { stateDir, paths, runtime } = await bootRuntime();
  const signals = vi.spyOn(process, 'kill');

  try {
    // The host here stays alive the whole time, which is the case a signal-based stop cannot answer: the
    // runtime closes inside a process that outlives it, so the only proof of the close is the record that
    // close writes. Reading it is what ends this wait, not a timeout.
    const startedAt = Date.now();
    const stopped = await stopViaSocket(paths);

    expect(stopped).toMatchObject({
      stopped: true,
      mode: 'graceful',
      cleanupConfidence: 'known',
      warnings: [],
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    // The runtime left by its own close, and the record it wrote is what the stop waited for.
    await expect(runtime.closed).resolves.toMatchObject({ requests: { abandoned: 0 } });
    const completion = readDaemonShutdownRecord(paths.baseDir).completion;
    expect(completion?.outcome).toBe('released');
    expect(completion?.unfinished).toEqual([]);
    // Every stop addressed to that instance reads this answer, and a stop addressed to another one
    // reads nothing — a recycled pid must not inherit an answer it was not part of.
    expect(
      daemonShutdownCompletionAnswers(completion!, {
        pid: completion!.pid,
        processStartTime: completion!.processStartTime,
        token: completion!.token,
      }),
    ).toBe(true);
    expect(
      daemonShutdownCompletionAnswers(completion!, {
        pid: 42,
        processStartTime: 'x',
        token: 'other',
      }),
    ).toBe(false);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(hostSignals(signals)).toEqual([]);
  } finally {
    signals.mockRestore();
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a stop performed without the shutdown route is refused and leaves the runtime serving', async () => {
  const { stateDir, paths, runtime } = await bootRuntime();
  const signals = vi.spyOn(process, 'kill');

  try {
    // A caller that goes straight to the retirement funnel skips the shutdown request the embedded route
    // sends, and what it has left is a signal — exactly what must never reach a host process. `observed`
    // carries the owner the caller read, and the funnel refuses on it rather than proving an exit it
    // cannot prove.
    const observed = {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      ownership: 'embedded' as const,
    };
    const refusal = await stopDaemon({ paths, observed }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { retirement: { reason: 'embedded-owner' } },
    });

    expect(hostSignals(signals)).toEqual([]);
    // The refusal changed nothing: the runtime the host owns is still there to close.
    expect(readDaemonInfo(paths.infoPath)?.pid).toBe(process.pid);
    expect(await runtime.close()).toMatchObject({ requests: { abandoned: 0 } });
  } finally {
    signals.mockRestore();
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('two stops of one runtime both get the answer its close gives', async () => {
  const { stateDir, paths, runtime } = await bootRuntime();
  const signals = vi.spyOn(process, 'kill');

  try {
    // Started in the same tick, so both stops read the same embedded record and neither can be told it
    // is already gone. The runtime admits one shutdown and answers the other with the same
    // `draining` ack, so both are waiting on the one completion record this instance writes.
    const [first, second] = await Promise.all([stopViaSocket(paths), stopViaSocket(paths)]);

    for (const [label, stopped] of [
      ['first', first],
      ['second', second],
    ] as const) {
      expect(stopped, label).toMatchObject({
        stopped: true,
        mode: 'graceful',
        cleanupConfidence: 'known',
      });
      expect(stopped.warnings, label).toEqual([]);
    }
    await expect(runtime.closed).resolves.toMatchObject({ requests: { abandoned: 0 } });
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(hostSignals(signals)).toEqual([]);
  } finally {
    signals.mockRestore();
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test.each(['request', 'owner'] as const)(
  'direct close retaining %s work answers two later stops with an old timestamp field',
  async (kind) => {
    const { stateDir, paths, runtime } = await bootRuntime();
    const signals = vi.spyOn(process, 'kill');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pending: Promise<unknown> | undefined;
    if (kind === 'request') {
      stopProbe.request = held;
      const entered = new Promise<void>((resolve) => {
        stopProbe.entered = resolve;
      });
      pending = sendRequest(
        readDaemonInfo(paths.infoPath)!,
        { token: runtime.token, command: 'session_list', positionals: [], session: 'default' },
        'http',
        paths,
        5_000,
        { host: createTestHostEnvironment(), timeoutRecovery: 'none' },
      ).catch(() => {});
      await entered;
    } else {
      stopProbe.owner = held;
    }
    try {
      await runtime.close();
      const file = resolveDaemonShutdownReportPath(stateDir);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(record.completion.outcome).toBe('retained');
      fs.writeFileSync(
        file,
        JSON.stringify({
          ...record,
          completion: { ...record.completion, writtenAtMs: Date.now() - 61_000 },
        }),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const stopped = await stopViaSocket(paths);
        expect(stopped).toMatchObject({
          stopped: true,
          mode: 'graceful',
          cleanupConfidence: 'unknown',
          providerReleases: { status: 'completed' },
        });
        expect(stopped.warnings.join(' ')).toContain(
          kind === 'request' ? 'ignored cancellation' : 'platform owners',
        );
        expect(stopped.warnings.join(' ')).toContain('keeps its registration');
      }
      expect(fs.existsSync(paths.infoPath)).toBe(true);
      expect(fs.existsSync(paths.lockPath)).toBe(true);
      expect(hostSignals(signals)).toEqual([]);
    } finally {
      release();
      await pending;
      await runtime.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

/**
 * A record naming a child process that is about to be killed, with a port nothing listens on: the shape a
 * host leaves when it dies, or when its age makes its record the only thing a later stop can read.
 */
async function plantDeadWriterRecord(paths: ReturnType<typeof resolveDaemonPaths>) {
  const writer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  const pid = writer.pid ?? -1;
  const startTime = await startTimeOf(pid);
  fs.writeFileSync(
    paths.infoPath,
    JSON.stringify({
      pid,
      processStartTime: startTime,
      token: 'local-secret',
      // A port nothing listens on: the ask cannot reach a runtime that is already gone.
      port: await closedLoopbackPort(),
      ownership: 'embedded',
    }),
  );
  writer.kill('SIGKILL');
  await once(writer, 'exit');
  return { pid, processStartTime: startTime, token: 'local-secret' };
}

test('a stop whose runtime died before writing its report does not wait on a dead writer', async () => {
  // A host killed between removing the registration and publishing its completion record leaves a stop
  // with no writer. The lifetime is the second piece of evidence, and it has to answer: sitting out the
  // whole budget to report an unconfirmed failure would describe a close that had plainly ended.
  const stateDir = mkdtempForTestSync('agent-device-embedded-stop-dead-writer-');
  const paths = resolveDaemonPaths(stateDir);
  await plantDeadWriterRecord(paths);
  const signals = vi.spyOn(process, 'kill');

  try {
    const startedAt = Date.now();
    const stopped = await stopViaSocket(paths);

    expect(stopped).toMatchObject({ stopped: false, mode: 'not-running' });
    // Proof, not a timeout: the budget this stop would otherwise sit out is a minute long.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(hostSignals(signals)).toEqual([]);
  } finally {
    signals.mockRestore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test.each(['retained', 'released'] as const)(
  'a dead writer with %s completion and an old timestamp field reports its actual close',
  async (outcome) => {
    // A retained record answers a later stop while the lifetime that wrote it is still live. Once that
    // process is gone, nothing holds the state directory any more, and reporting a graceful stop would
    // send the operator away from the one thing left to do: the takeover path that clears the stale record.
    const stateDir = mkdtempForTestSync('agent-device-embedded-stop-dead-retention-');
    const paths = resolveDaemonPaths(stateDir);
    const instance = await plantDeadWriterRecord(paths);
    fs.writeFileSync(
      resolveDaemonShutdownReportPath(paths.baseDir),
      `${JSON.stringify({
        completion: {
          ...instance,
          outcome,
          unfinished: ['1 in-flight request ignored cancellation'],
        },
        writtenAtMs: Date.now() - 60_000 - 1000,
      })}\n`,
      { mode: 0o600 },
    );
    const signals = vi.spyOn(process, 'kill');

    try {
      const startedAt = Date.now();
      const stopped = await stopViaSocket(paths);

      expect(stopped).toMatchObject(
        outcome === 'retained'
          ? { stopped: false, mode: 'not-running' }
          : { stopped: true, mode: 'graceful', cleanupConfidence: 'unknown' },
      );
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(hostSignals(signals)).toEqual([]);
    } finally {
      signals.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

// A record can claim a host-owned runtime and still be unusable: a file that is not JSON, or one that
// names no transport. Neither is an absence, and `not-running` would tell the operator to move on while
// a host may be serving on that very state directory. The two refusals are separate because the fixes
// are: a file that cannot be parsed says nothing about who owns the process, so nothing is even addressed.
test('a stop of a record it cannot address refuses instead of reporting nothing runs', async () => {
  for (const [label, record, reason, recordState] of [
    ['unreadable', '{not json', 'daemon-record-unreadable', undefined],
    [
      'no transport',
      JSON.stringify({
        pid: process.pid,
        processStartTime: readProcessStartTime(process.pid),
        ownership: 'embedded',
      }),
      'daemon-embedded-stop-unreachable',
      'incomplete',
    ],
  ] as const) {
    const stateDir = mkdtempForTestSync('agent-device-embedded-stop-record-');
    const paths = resolveDaemonPaths(stateDir);
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.infoPath, record, { mode: 0o600 });
    const signals = vi.spyOn(process, 'kill');

    try {
      const refusal = await stopViaSocket(paths).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal, label).toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          reason,
          stateDir: paths.baseDir,
          ...(recordState ? { record: recordState } : {}),
        },
      });
      expect(hostSignals(signals), label).toEqual([]);
      // Refusing changes nothing: whatever owns that record still does.
      expect(fs.readFileSync(paths.infoPath, 'utf8'), label).toBe(record);
    } finally {
      signals.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

// A record this build cannot place still gets the authenticated request rather than a signal: asking is
// free, and the runtime's own answer says whose process this is. What the answer must not do is name
// `daemon stop`, because that command refuses to signal a record whose owner it cannot prove either — the
// operator needs the record repair, which is the only fix for a file that states nothing usable.
test('a detached answer against an unreadable owner names the record repair, not daemon stop', async () => {
  const { stateDir, paths, runtime } = await bootRuntimeWithUnplaceableRecordOwner('detached');
  const signals = vi.spyOn(process, 'kill');

  try {
    const refusal = await stopViaSocket(paths).then(
      () => null,
      (error: unknown) => error,
    );
    // The runtime knows its own owner, and it is not a host: it answers the shutdown request the way a
    // detached daemon does.
    expect(refusal).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'daemon-not-embedded' },
    });
    const hint = String((refusal as { details: { hint: string } }).details.hint);
    expect(hint).toMatch(/daemon\.json/);
    expect(hint).not.toMatch(/daemon stop/);
    expect(hostSignals(signals)).toEqual([]);
    expect(await runtime.close()).toMatchObject({ requests: { abandoned: 0 } });
  } finally {
    signals.mockRestore();
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// The same rewritten record under a runtime that really is host-owned. Asking is still the right move:
// the runtime answers for itself, agrees, and closes its own process. Nothing here signals, and the stop
// does not need the record to say who owns it — the answer is the proof.
test('an unrecognized owner under a host-owned runtime leaves by its own shutdown request', async () => {
  const { stateDir, paths, runtime } = await bootRuntimeWithUnplaceableRecordOwner('embedded');
  const signals = vi.spyOn(process, 'kill');

  try {
    expect(await stopViaSocket(paths)).toMatchObject({ stopped: true, mode: 'graceful' });
    await expect(runtime.closed).resolves.toBeTruthy();
    expect(hostSignals(signals)).toEqual([]);
  } finally {
    signals.mockRestore();
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a second stop of a host-owned runtime reports nothing left to stop', async () => {
  const { stateDir, paths, runtime } = await bootRuntime();

  try {
    expect(await stopViaSocket(paths)).toMatchObject({ stopped: true, mode: 'graceful' });
    await expect(runtime.closed).resolves.toBeTruthy();

    // The instance is gone, so this is not a refused stop or an unconfirmed one: there is nothing there.
    expect(await stopViaSocket(paths)).toMatchObject({
      stopped: false,
      mode: 'not-running',
    });
  } finally {
    await runtime.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test.each(['no answer', 'same-host successor'] as const)(
  'a live host with %s never supplies false completion',
  async (scenario) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-fenced-'));
    const original = {
      pid: process.pid,
      processStartTime: readProcessStartTime(process.pid)!,
      token: 'runtime-a',
      port: 4210,
      ownership: 'embedded',
    };
    fs.writeFileSync(paths.infoPath, JSON.stringify(original));
    const observed = readDaemonStopIdentity(paths.infoPath);
    const successor = { ...original, token: 'runtime-b' };
    fs.writeFileSync(paths.infoPath, JSON.stringify(successor));
    vi.spyOn(processWait, 'waitForDaemonExit').mockResolvedValue({ exited: false, elapsedMs: 0 });
    const send = vi.spyOn(transport, 'sendRequest').mockImplementation(async (info, request) => {
      expect(info.token).toBe('runtime-a');
      expect(request.token).toBe('runtime-a');
      if (scenario === 'same-host successor')
        fs.writeFileSync(
          resolveDaemonShutdownReportPath(paths.baseDir),
          JSON.stringify({
            completion: { ...successor, outcome: 'released', unfinished: [] },
            providerReleases: { released: [{ leaseId: 'successor-only' }], pending: [] },
          }),
        );
      throw new AppError('COMMAND_FAILED', 'connection refused', {
        reason: 'daemon_transport_failure',
      });
    });
    const signals = vi.spyOn(process, 'kill');
    vi.useFakeTimers();
    const stop = stopRecordedDaemon(observed, { paths, host: createTestHostEnvironment() });
    const result = expect(stop).rejects.toMatchObject({
      details: { reason: 'daemon-shutdown-unconfirmed' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(paths.infoPath, 'utf8')).token).toBe('runtime-b');
    expect(hostSignals(signals)).toEqual([]);
  },
);

test.each([true, false])('startup retry requires the typed busy reason (%s)', async (typed) => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-startup-'));
  const original = {
    pid: process.pid,
    processStartTime: readProcessStartTime(process.pid)!,
    token: 'starting-runtime',
    port: 4210,
    ownership: 'embedded',
  };
  fs.writeFileSync(paths.infoPath, JSON.stringify(original));
  const error = new AppError('COMMAND_FAILED', 'The daemon is still starting up.', {
    ...(typed ? { reason: 'daemon-busy' } : {}),
    startingUp: true,
    inFlightRequests: 0,
    sessions: 0,
    repairSessions: 0,
    leases: 0,
  });
  const send = vi.spyOn(transport, 'sendRequest').mockImplementation(async () => {
    fs.writeFileSync(
      resolveDaemonShutdownReportPath(paths.baseDir),
      JSON.stringify({
        completion: { ...original, outcome: 'released', unfinished: [] },
        providerReleases: { released: [{ leaseId: 'original-close' }], pending: [] },
      }),
    );
    throw error;
  });
  vi.useFakeTimers();
  const stop = stopViaSocket(paths);
  const checked = typed
    ? expect(stop).resolves.toMatchObject({
        stopped: true,
        mode: 'graceful',
        providerReleases: { released: [{ leaseId: 'original-close' }] },
      })
    : expect(stop).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(250);
  await checked;
  expect(send).toHaveBeenCalledTimes(1);
});

test('an unreachable embedded record without a birth fails promptly without guessing its lifetime', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-no-birth-'));
  const record = JSON.stringify({
    pid: process.pid,
    token: 'unreachable-runtime',
    httpPort: await closedLoopbackPort(),
    ownership: 'embedded',
  });
  fs.writeFileSync(paths.infoPath, record);
  const signals = vi.spyOn(process, 'kill');
  const startedAt = Date.now();
  try {
    await expect(stopViaSocket(paths)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'daemon-shutdown-unconfirmed' },
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(record);
    expect(hostSignals(signals)).toEqual([]);
  } finally {
    signals.mockRestore();
  }
});
