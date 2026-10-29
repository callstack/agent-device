import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, test, vi } from 'vitest';
import {
  isCommandTimeoutError,
  runCmd,
  runCmdBackground,
  runCmdStreaming,
  signalProcessGroupBestEffort,
  type ExecBackgroundOptions,
  type ExecStreamOptions,
} from './exec.ts';
import { shellQuote } from '@agent-device/kernel/device-shell';
import { sleep } from './retry.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

// A direct child can hand our stdout/stderr pipes to a descendant, and `close` waits
// for those pipes to drain: a command this module killed stayed unsettled — holding
// its request and the device lock it owns — until the descendant died by itself.
// `sh` and `sleep` stand in for the runtime, and the leaked holder is a timer, not a runtime.
//
// Real timers would arm a deadline at spawn, so on a loaded host it could fire before the shell
// reached the step a test is about. The deadline tests hold the module's clock instead — only
// `setTimeout` is faked, the child runs on the real one — and fire the deadline once the child
// has shown it reached that step.

const HOLDER_LIFETIME_SECONDS = 3;
const DEADLINE_MS = 400;

function markerPath(label: string, name: 'finished' | 'released'): string {
  return path.join(mkdtempForTestSync(`agent-device-exec-${label}-`), name);
}

// The holder announces its pid on the stdout it inherited, so the pid arriving is also the proof
// that the pipe is held. It writes `finished` as its last act before it exits and releases that
// pipe, so a command that waited for `close` always finds the marker; a liveness probe could
// still see the holder as a zombie nobody has reaped yet.
function pipeHolderShellScript(finishedPath: string, parent: 'wait' | 'exit 0'): string {
  return `{ sleep ${HOLDER_LIFETIME_SECONDS}; printf finished > ${shellQuote(finishedPath)}; } & printf %s $!; ${parent}`;
}

function holdModuleClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

afterEach(() => {
  vi.useRealTimers();
});

/** The child's first stdout chunk, or a failure when the command settles before it writes one. */
function stdoutAnnouncement(): {
  readonly onStdoutChunk: (chunk: string) => void;
  readonly before: (settled: Promise<unknown>) => Promise<string>;
} {
  let announce!: (chunk: string) => void;
  const announced = new Promise<string>((resolve) => (announce = resolve));
  return {
    onStdoutChunk: (chunk) => announce(chunk),
    before: (settled) =>
      Promise.race([
        announced,
        settled.then(() => {
          throw new Error('the command settled before its child announced itself');
        }),
      ]),
  };
}

/** The direct child once it exited, seen through the same `exit` event the command settles on. */
function directChildExit(): {
  readonly onSpawn: (child: ChildProcess) => void;
  readonly exited: Promise<ChildProcess>;
} {
  let onSpawn!: (child: ChildProcess) => void;
  const exited = new Promise<ChildProcess>((resolve) => {
    onSpawn = (child) => child.once('exit', () => resolve(child));
  });
  return { onSpawn, exited };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a live process owned by someone else; only ESRCH is absence.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessToExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (isProcessRunning(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}

function settledRejection<T>(promise: Promise<T>): Promise<{ error: unknown } | null> {
  return promise.then(
    () => null,
    (error: unknown) => ({ error }),
  );
}

test.runIf(process.platform !== 'win32')(
  'a command killed at its deadline settles on the child exit, not on an inherited pipe',
  async () => {
    const finishedPath = markerPath('timeout-holder', 'finished');
    holdModuleClock();
    const holder = stdoutAnnouncement();
    const killed = runCmdStreaming('/bin/sh', ['-c', pipeHolderShellScript(finishedPath, 'wait')], {
      timeoutMs: DEADLINE_MS,
      captureOutput: false,
      onStdoutChunk: holder.onStdoutChunk,
    });
    const rejection = settledRejection(killed);

    await holder.before(rejection);
    vi.advanceTimersByTime(DEADLINE_MS);
    const outcome = await rejection;

    assert.ok(outcome, 'a command killed at its deadline must not resolve');
    assert.ok(isCommandTimeoutError(outcome.error));
    assert.equal(
      fs.existsSync(finishedPath),
      false,
      'settled only once the pipe holder died, which is the wedge this settles before',
    );
  },
);

test.runIf(process.platform !== 'win32')(
  'a deadline on a detached command kills the descendant that inherited the pipes',
  async () => {
    const finishedPath = markerPath('detached-holder', 'finished');
    holdModuleClock();
    const holder = stdoutAnnouncement();
    const killed = runCmdStreaming('/bin/sh', ['-c', pipeHolderShellScript(finishedPath, 'wait')], {
      timeoutMs: DEADLINE_MS,
      detached: true,
      captureOutput: false,
      onStdoutChunk: holder.onStdoutChunk,
    });
    const rejection = settledRejection(killed);

    const holderPid = Number(await holder.before(rejection));
    vi.advanceTimersByTime(DEADLINE_MS);
    vi.useRealTimers();
    const outcome = await rejection;

    assert.ok(outcome);
    assert.ok(isCommandTimeoutError(outcome.error));
    assert.equal(
      await waitForProcessToExit(holderPid),
      true,
      'the process-group kill left the inherited-pipe holder running',
    );
  },
);

test.runIf(process.platform !== 'win32')(
  'runCmdBackground killed by request cancellation settles on the child exit',
  async () => {
    const finishedPath = markerPath('abort-holder', 'finished');
    const controller = new AbortController();
    const holder = stdoutAnnouncement();
    const { child, wait } = runCmdBackground(
      '/bin/sh',
      ['-c', pipeHolderShellScript(finishedPath, 'wait')],
      { signal: controller.signal, captureOutput: false },
    );
    child.stdout?.on('data', (chunk) => holder.onStdoutChunk(String(chunk)));
    const rejection = settledRejection(wait);

    await holder.before(rejection);
    controller.abort();
    const outcome = await rejection;

    assert.ok(outcome, 'a canceled background command must not resolve');
    assert.equal(
      fs.existsSync(finishedPath),
      false,
      'settled only once the pipe holder died, which is the wedge this settles before',
    );
    const details = (outcome.error as { details?: Record<string, unknown> }).details;
    assert.equal(details?.reason, 'request_canceled');
  },
);

test.runIf(process.platform !== 'win32')(
  'a deadline that fires after the child exited settles without waiting for the pipe holder',
  async () => {
    // The direct child is gone, so no kill can reach the descendant that inherited its
    // pipes, and `close` only arrives when that descendant finishes. Settlement has to
    // come from the deadline noticing an already-exited child.
    const { outcome, holderFinished } = await deadlineAfterChildExit({});

    assert.ok(isCommandTimeoutError(outcome.error));
    assert.equal(holderFinished, false, 'settled only once the pipe holder finished');
  },
);

/**
 * Runs a child that leaves a pipe holder behind and exits, and fires the deadline only once
 * that exit was seen, so the deadline always meets an already-exited child.
 */
async function deadlineAfterChildExit(options: Pick<ExecStreamOptions, 'detached'>): Promise<{
  outcome: { error: unknown };
  holderFinished: boolean;
  childPid: number;
}> {
  const finishedPath = markerPath('exited-holder', 'finished');
  holdModuleClock();
  const holder = stdoutAnnouncement();
  const child = directChildExit();
  const rejection = settledRejection(
    runCmdStreaming('/bin/sh', ['-c', pipeHolderShellScript(finishedPath, 'exit 0')], {
      ...options,
      timeoutMs: DEADLINE_MS,
      captureOutput: false,
      onStdoutChunk: holder.onStdoutChunk,
      onSpawn: child.onSpawn,
    }),
  );

  const [, exited] = await Promise.all([holder.before(rejection), child.exited]);
  vi.advanceTimersByTime(DEADLINE_MS);
  const outcome = await rejection;
  assert.ok(outcome, 'a command killed at its deadline must not resolve');
  return { outcome, holderFinished: fs.existsSync(finishedPath), childPid: exited.pid ?? 0 };
}

// A command this module asked to be killed is finished once its child is gone, without
// waiting for the stdio pipes to drain: a descendant that inherited them keeps `close`
// from arriving, and the request behind the command — and the device lock it holds —
// would wait forever. Whether the kill request or the child's exit arrives first is not a
// question the callers answer, so both report to one settlement.
//
// The kill paths below address a process group whose leader this worker already reaped, and
// the hermetic signal setup ends a worker's authority over a pid at that moment. So every group
// write is answered by `guardGroupWrites` below, which is the seam that setup points a real kill
// path at: it records what the kill aimed at and answers the way `process.kill` does — `true` for a
// write the kernel accepted, `ESRCH` for a group that is gone, `EPERM` for one that is not ours.

type GroupWrite = { readonly pid: number; readonly signal: string | number };

/** How a guarded group write answers, matching what `process.kill` does with a negative pid. */
type GroupWriteAnswer = 'delivered' | 'no-such-process' | 'not-permitted';

function guardGroupWrites(answer: GroupWriteAnswer = 'delivered'): {
  restore: () => void;
  writes: GroupWrite[];
} {
  const original = process.kill.bind(process);
  const writes: GroupWrite[] = [];
  process.kill = ((pid: number, signal: string | number = 'SIGTERM') => {
    if (pid < 0) {
      writes.push({ pid, signal });
      if (answer === 'no-such-process' || answer === 'not-permitted') {
        const error = new Error(
          answer === 'no-such-process' ? 'no such process' : 'operation not permitted',
        ) as NodeJS.ErrnoException;
        error.code = answer === 'no-such-process' ? 'ESRCH' : 'EPERM';
        throw error;
      }
      return true;
    }
    return original(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  return { writes, restore: () => (process.kill = original) };
}

// One seam, one double. Every group write in this file — the direct calls below included — is answered
// by `guardGroupWrites`, so a hand-written spy beside it would be a second answer to the same question,
// and the two are free to drift from each other.
test('the group signal seam answers each way process.kill answers a negative pid', () => {
  // `true` once the kernel accepted the write; `ESRCH` when no member is left and `EPERM` when a
  // member belongs to another user. The two throws are the same answer to this seam — nothing was
  // reached, so the caller must not keep waiting on a pipe holder it just asked to be killed.
  const cases = [
    ['delivered', true],
    ['no-such-process', false],
    ['not-permitted', false],
  ] as const;
  for (const [answer, reported] of cases) {
    const groupWrites = guardGroupWrites(answer);
    try {
      assert.equal(signalProcessGroupBestEffort(101, 'SIGKILL'), reported, answer);
      assert.deepEqual(groupWrites.writes, [{ pid: -101, signal: 'SIGKILL' }], answer);
    } finally {
      groupWrites.restore();
    }
  }
});

test('an invalid pid is refused before anything is signalled', () => {
  // A zero or negative pid would address this worker's own group, or every process the user owns. The
  // guard records every write it is asked about, so an empty list is the proof none was attempted.
  const groupWrites = guardGroupWrites();
  try {
    assert.equal(signalProcessGroupBestEffort(0, 'SIGTERM'), false);
    assert.equal(signalProcessGroupBestEffort(-1, 'SIGTERM'), false);
    assert.equal(signalProcessGroupBestEffort(1.5, 'SIGTERM'), false);
    assert.deepEqual(groupWrites.writes, []);
  } finally {
    groupWrites.restore();
  }
});

test.runIf(process.platform !== 'win32')(
  'a detached deadline still kills the group its reaped child left behind',
  async () => {
    const groupWrites = guardGroupWrites();
    try {
      const { outcome, holderFinished, childPid } = await deadlineAfterChildExit({
        detached: true,
      });

      assert.ok(isCommandTimeoutError(outcome.error));
      assert.equal(holderFinished, false, 'settled only once the pipe holder finished');
      assert.deepEqual(groupWrites.writes, [{ pid: -childPid, signal: 'SIGKILL' }]);
    } finally {
      groupWrites.restore();
    }
  },
);

test.runIf(process.platform !== 'win32')(
  'a detached deadline whose group cannot be signalled still settles',
  async () => {
    // A vanished group answers the group write by throwing `ESRCH`, and a group owned by someone
    // else by throwing `EPERM`; the seam swallows both. The command still cannot wait on a pipe
    // holder it just asked to be killed.
    const groupWrites = guardGroupWrites('no-such-process');
    try {
      const { outcome, holderFinished } = await deadlineAfterChildExit({ detached: true });

      assert.ok(isCommandTimeoutError(outcome.error));
      assert.equal(holderFinished, false, 'settled only once the pipe holder finished');
      assert.equal(groupWrites.writes.length, 1);
    } finally {
      groupWrites.restore();
    }
  },
);

test.runIf(process.platform !== 'win32')(
  'a request that was already canceled kills the command it arrives on',
  async () => {
    // The kill is issued before the caller finishes wiring, so a settlement that read
    // the watcher mid-construction would fail here rather than at the next await.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runCmd('/bin/sh', ['-c', 'sleep 5'], { signal: controller.signal }),
      (error: unknown) => {
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.reason,
          'request_canceled',
        );
        return true;
      },
    );
  },
  5_000,
);

test.runIf(process.platform !== 'win32')(
  'a background request that was already canceled ends its wait',
  async () => {
    const controller = new AbortController();
    controller.abort();
    const background = runCmdBackground('/bin/sh', ['-c', 'sleep 5'], {
      signal: controller.signal,
    });

    await assert.rejects(
      () => background.wait,
      (error: unknown) => {
        assert.equal(
          (error as { details?: Record<string, unknown> }).details?.reason,
          'request_canceled',
        );
        return true;
      },
    );
  },
  5_000,
);

// A child that holds something the kill would strand — the macOS helper with the mouse button
// down — asks for a signal it can handle before SIGKILL. The trap script below stands in for
// that helper: it records the release the signal handler performs, and its `sleep` is the
// hold the kill interrupts.

// `ready` is printed only once the trap is installed and the hold has started, so a signal sent
// after it arrives always reaches the handler.
function holdUntilSignalledShellScript(releasedPath: string): string {
  return `trap 'printf released > ${shellQuote(releasedPath)}; exit 143' TERM; sleep ${HOLDER_LIFETIME_SECONDS} & printf ready; wait`;
}

test.runIf(process.platform !== 'win32')(
  'a cancelled command with a kill policy is signalled so it can release what it holds',
  async () => {
    const releasedPath = markerPath('graceful-abort', 'released');
    const controller = new AbortController();
    const trap = stdoutAnnouncement();
    const held = runCmdStreaming('/bin/sh', ['-c', holdUntilSignalledShellScript(releasedPath)], {
      signal: controller.signal,
      kill: { signal: 'SIGTERM', graceMs: 2_000 },
      captureOutput: false,
      onStdoutChunk: trap.onStdoutChunk,
    });
    const rejection = settledRejection(held);
    await trap.before(rejection);

    controller.abort();
    const outcome = await rejection;

    assert.ok(outcome, 'a cancelled command must not resolve');
    const details = (outcome.error as { details?: Record<string, unknown> }).details;
    assert.equal(details?.reason, 'request_canceled');
    assert.equal(
      fs.readFileSync(releasedPath, 'utf8'),
      'released',
      'the child never saw the signal its handler releases on: it was killed outright',
    );
  },
);

// The grace runs on the same held clock as the deadline, so each escalation step is read from
// the signals the child was sent at an exact point on that clock.
test.runIf(process.platform !== 'win32')(
  'a deadline with a kill policy still ends a child that ignores the first signal',
  async () => {
    const graceMs = 200;
    holdModuleClock();
    let child: ChildProcess | undefined;
    let sentSignals: () => unknown[] = () => [];
    try {
      const trap = stdoutAnnouncement();
      const ignoring = runCmdStreaming(
        '/bin/sh',
        ['-c', `trap '' TERM; sleep ${HOLDER_LIFETIME_SECONDS} & printf ready; wait`],
        {
          timeoutMs: DEADLINE_MS,
          kill: { signal: 'SIGTERM', graceMs },
          captureOutput: false,
          onStdoutChunk: trap.onStdoutChunk,
          onSpawn: (spawned) => {
            child = spawned;
            const kill = vi.spyOn(spawned, 'kill');
            sentSignals = () => kill.mock.calls.map(([signal]) => signal);
          },
        },
      );
      const rejection = settledRejection(ignoring);
      await trap.before(rejection);

      vi.advanceTimersByTime(DEADLINE_MS);
      assert.deepEqual(sentSignals(), ['SIGTERM'], 'the deadline did not send the policy signal');
      vi.advanceTimersByTime(graceMs - 1);
      assert.deepEqual(sentSignals(), ['SIGTERM'], 'escalated before the grace passed');
      vi.advanceTimersByTime(1);
      assert.deepEqual(
        sentSignals(),
        ['SIGTERM', 'SIGKILL'],
        'the grace became a way to outlive the deadline',
      );

      const outcome = await rejection;
      assert.ok(outcome, 'a command killed at its deadline must not resolve');
      assert.ok(isCommandTimeoutError(outcome.error));
      assert.equal(child?.signalCode, 'SIGKILL', 'the first signal ended the child, not SIGKILL');
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
  10_000,
);

test.runIf(process.platform !== 'win32')(
  'runCmd that was never killed still drains output a descendant writes after its parent exited',
  async () => {
    const result = await runCmd('/bin/sh', ['-c', 'printf head; { sleep 0.2; printf tail; } &']);

    assert.equal(result.stdout, 'headtail');
  },
);

test('a killed command still fails with its deadline even when it allowed failure', async () => {
  const outcome = await runCmd(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    timeoutMs: 60,
    allowFailure: true,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(isCommandTimeoutError(outcome));
});

test('binaryStdout returns every byte the command wrote', async () => {
  const bytes = 4096;
  const result = await runCmd(
    process.execPath,
    ['-e', 'process.stdout.write(Buffer.alloc(4096, 7))'],
    { binaryStdout: true },
  );

  assert.equal(result.stdout, '');
  assert.equal(result.stdoutBuffer?.length, bytes);
});

test('runCmdBackground captures the full stdout of a child that writes over a megabyte', async () => {
  const bytes = 1_500_000;
  const { wait } = runCmdBackground(process.execPath, [
    '-e',
    `process.stdout.write("a".repeat(${bytes}))`,
  ]);

  const result = await wait;

  assert.equal(result.stdout.length, bytes);
});

test('background exec arms no deadline when timeoutMs crosses an unchecked options spread', async () => {
  const leakedOptions = { timeoutMs: 20 } as unknown as ExecBackgroundOptions;

  const { wait } = runCmdBackground(
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 150)'],
    leakedOptions,
  );

  const result = await wait;

  assert.equal(result.exitCode, 0);
});
