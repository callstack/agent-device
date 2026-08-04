import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

vi.mock('../timeouts.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../timeouts.ts')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

import { exitAfterFlush } from '../process-exit.ts';
import { sleep } from '../timeouts.ts';

type FakeWriteStream = {
  writableLength: number;
  once: ReturnType<typeof vi.fn>;
};

function installFakeStdio(streams: {
  stdout: FakeWriteStream;
  stderr: FakeWriteStream;
}): () => void {
  const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
  const originalStderr = Object.getOwnPropertyDescriptor(process, 'stderr');
  Object.defineProperty(process, 'stdout', { value: streams.stdout, configurable: true });
  Object.defineProperty(process, 'stderr', { value: streams.stderr, configurable: true });
  return () => {
    if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout);
    if (originalStderr) Object.defineProperty(process, 'stderr', originalStderr);
  };
}

function installExitSpy(): { calls: number[]; restore: () => void } {
  const originalExit = process.exit;
  const calls: number[] = [];
  (process as any).exit = ((code?: number) => {
    calls.push(code ?? 0);
  }) as typeof process.exit;
  return { calls, restore: () => (process.exit = originalExit) };
}

function drainedStream(): FakeWriteStream {
  return { writableLength: 0, once: vi.fn() };
}

afterEach(() => {
  vi.clearAllMocks();
});

test('exitAfterFlush exits immediately when both streams are already drained', async () => {
  const restoreStdio = installFakeStdio({ stdout: drainedStream(), stderr: drainedStream() });
  const exitSpy = installExitSpy();

  try {
    await exitAfterFlush(1);
  } finally {
    restoreStdio();
    exitSpy.restore();
  }

  assert.deepEqual(exitSpy.calls, [1]);
});

// #1596: proves the queued-write branch — a stream with buffered data must be
// let drain before the process exits, not raced against immediately.
test('exitAfterFlush waits for a backlogged stream to drain before exiting', async () => {
  // The FLUSH_TIMEOUT_MS race's other arm is `sleep`, mocked module-wide to
  // resolve immediately; override it here to a promise that never resolves so
  // this test can only pass via the drain callback, not the timeout racing
  // ahead of it.
  vi.mocked(sleep).mockImplementationOnce(() => new Promise(() => {}));
  let drainCallback: (() => void) | undefined;
  const backloggedStderr: FakeWriteStream = {
    writableLength: 1024,
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'drain') drainCallback = cb;
    }),
  };
  const restoreStdio = installFakeStdio({ stdout: drainedStream(), stderr: backloggedStderr });
  const exitSpy = installExitSpy();

  try {
    const pending = exitAfterFlush(2);
    // Give the microtask queue a turn: exit must not have fired yet, since the
    // backlogged stream hasn't drained.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(exitSpy.calls, [], 'exit fired before the backlogged stream drained');
    assert.equal(typeof drainCallback, 'function');

    drainCallback?.();
    await pending;
  } finally {
    restoreStdio();
    exitSpy.restore();
  }

  assert.deepEqual(exitSpy.calls, [2]);
});

// A stream that never emits 'drain' (a stalled or broken pipe) must not hang
// the process — the FLUSH_TIMEOUT_MS race still exits. `sleep` is mocked
// above so this resolves instantly instead of waiting the real timeout.
test('exitAfterFlush still exits when a stream never drains', async () => {
  const neverDrains: FakeWriteStream = { writableLength: 1024, once: vi.fn() };
  const restoreStdio = installFakeStdio({ stdout: drainedStream(), stderr: neverDrains });
  const exitSpy = installExitSpy();

  try {
    await exitAfterFlush(3);
  } finally {
    restoreStdio();
    exitSpy.restore();
  }

  assert.deepEqual(exitSpy.calls, [3]);
});
