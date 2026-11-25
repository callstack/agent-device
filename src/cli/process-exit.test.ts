import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { exitAfterFlush, writeStderrBestEffort } from './process-exit.ts';

const FLUSH_TIMEOUT_MS = 2000;

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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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
  // Timers are faked and never advanced past the flush deadline here, so this
  // test can only pass via the drain callback, not the deadline.
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
    // Just short of the deadline, exit must not have fired: the backlogged
    // stream hasn't drained.
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
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
// the process — the FLUSH_TIMEOUT_MS deadline still exits.
test('exitAfterFlush still exits when a stream never drains', async () => {
  const neverDrains: FakeWriteStream = { writableLength: 1024, once: vi.fn() };
  const restoreStdio = installFakeStdio({ stdout: drainedStream(), stderr: neverDrains });
  const exitSpy = installExitSpy();

  try {
    const pending = exitAfterFlush(3);
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
    assert.deepEqual(exitSpy.calls, [], 'exit fired before the flush deadline');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  } finally {
    restoreStdio();
    exitSpy.restore();
  }

  assert.deepEqual(exitSpy.calls, [3]);
});

test('best-effort stderr absorbs an asynchronous write error', async () => {
  let attempted = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      attempted = String(chunk);
      queueMicrotask(() => done(Object.assign(new Error('closed pipe'), { code: 'EPIPE' })));
    },
  });
  const closed = new Promise<void>((resolve) => stream.once('close', resolve));

  writeStderrBestEffort('allocation progress\n', stream);
  await closed;
  assert.equal(attempted, 'allocation progress\n');
  assert.equal(stream.listenerCount('error'), 0);
});

test('a completed best-effort stderr write does not absorb later stream errors', async () => {
  const stream = new Writable({ write: (_chunk, _encoding, done) => done() });
  writeStderrBestEffort('allocation progress\n', stream);
  writeStderrBestEffort('more allocation progress\n', stream);
  assert.equal(stream.listenerCount('error'), 1);
  await new Promise<void>((resolve, reject) => {
    stream.write('ordinary diagnostic\n', (error) => (error ? reject(error) : resolve()));
  });

  const failure = new Error('unrelated stderr failure');
  assert.throws(
    () => stream.emit('error', failure),
    (error) => error === failure,
  );
});
