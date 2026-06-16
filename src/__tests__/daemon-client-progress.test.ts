import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../daemon/types.ts';
import { readDaemonSocketProgressResponse } from '../daemon-client-progress.ts';
import { AppError } from '../utils/errors.ts';

type MockSocket = EventEmitter & {
  ended: boolean;
  encoding?: string;
  end: () => MockSocket;
  setEncoding: (encoding: BufferEncoding) => MockSocket;
};

function createMockSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.ended = false;
  socket.end = () => {
    socket.ended = true;
    socket.emit('close');
    return socket;
  };
  socket.setEncoding = (encoding) => {
    socket.encoding = encoding;
    return socket;
  };
  return socket;
}

function readSocketProgressResponse(
  socket: MockSocket,
  req: DaemonRequest,
): Promise<DaemonResponse> {
  let settled = false;
  return new Promise((resolve, reject) => {
    readDaemonSocketProgressResponse(socket as unknown as Socket, {
      req,
      isSettled: () => settled,
      clearTimeout: () => {},
      resolve: (response) => {
        settled = true;
        resolve(response);
      },
      reject: (error) => {
        settled = true;
        reject(error);
      },
    });
  });
}

function withStderrTerminal<T>(params: { isTTY: boolean; columns: number }, run: () => T): T {
  const stderr = process.stderr as typeof process.stderr & {
    isTTY?: boolean;
    columns?: number;
  };
  const mutableStderr = stderr as unknown as Record<string, unknown>;
  const originalIsTTY = Object.getOwnPropertyDescriptor(stderr, 'isTTY');
  const originalColumns = Object.getOwnPropertyDescriptor(stderr, 'columns');
  try {
    Object.defineProperty(stderr, 'isTTY', {
      configurable: true,
      value: params.isTTY,
    });
    Object.defineProperty(stderr, 'columns', {
      configurable: true,
      value: params.columns,
    });
    return run();
  } finally {
    if (originalIsTTY) Object.defineProperty(stderr, 'isTTY', originalIsTTY);
    else delete mutableStderr.isTTY;
    if (originalColumns) Object.defineProperty(stderr, 'columns', originalColumns);
    else delete mutableStderr.columns;
  }
}

test('readDaemonSocketProgressResponse parses split progress lines before response envelopes', async () => {
  const socket = createMockSocket();
  const req: DaemonRequest = {
    session: 'default',
    command: 'test',
    positionals: ['/tmp/replays'],
    flags: {},
    token: 'secret',
    meta: { requestId: 'req-socket-progress', requestProgress: 'replay-test' },
  };
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = readSocketProgressResponse(socket, req);
    const progressLine = JSON.stringify({
      type: 'progress',
      event: {
        type: 'replay-test',
        file: '/tmp/01-login.ad',
        title: 'Login flow',
        status: 'pass',
        index: 1,
        total: 2,
        attempt: 1,
        maxAttempts: 2,
        durationMs: 1234,
      },
    });
    const responseLine = JSON.stringify({
      type: 'response',
      response: { ok: true, data: { via: 'socket-progress' } },
    });

    socket.emit('data', progressLine.slice(0, 24));
    socket.emit('data', `${progressLine.slice(24)}\n${responseLine}\n`);
    socket.emit('data', '{not-json-after-settle}\n');

    await assert.doesNotReject(responsePromise);
    assert.deepEqual(await responsePromise, { ok: true, data: { via: 'socket-progress' } });
    assert.equal(socket.encoding, 'utf8');
    assert.equal(socket.ended, true);
    assert.match(stderr, /✓ "Login flow" in 01-login\.ad \(1\.23s\)/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse rewrites live progress and clears it for final result', async () => {
  const socket = createMockSocket();
  const req: DaemonRequest = {
    session: 'default',
    command: 'test',
    positionals: ['/tmp/replays'],
    flags: {},
    token: 'secret',
    meta: { requestId: 'req-live-progress', requestProgress: 'replay-test' },
  };
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalCi = process.env.CI;

  try {
    delete process.env.CI;
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = withStderrTerminal({ isTTY: true, columns: 53 }, () =>
      readSocketProgressResponse(socket, req),
    );
    const progress = (stepIndex: number) =>
      JSON.stringify({
        type: 'progress',
        event: {
          type: 'replay-test',
          file: '/tmp/tab-view-coverflow.yml',
          title: 'Tab View - Coverflow',
          status: 'progress',
          index: 1,
          total: 1,
          attempt: 1,
          maxAttempts: 1,
          stepIndex,
          stepTotal: 10,
        },
      });
    const pass = JSON.stringify({
      type: 'progress',
      event: {
        type: 'replay-test',
        file: '/tmp/tab-view-coverflow.yml',
        title: 'Tab View - Coverflow',
        status: 'pass',
        index: 1,
        total: 1,
        attempt: 1,
        maxAttempts: 1,
        durationMs: 17_800,
      },
    });
    const responseLine = JSON.stringify({
      type: 'response',
      response: { ok: true, data: { via: 'socket-progress' } },
    });

    socket.emit('data', `${progress(3)}\n${progress(4)}\n${pass}\n${responseLine}\n`);

    assert.deepEqual(await responsePromise, { ok: true, data: { via: 'socket-progress' } });
    assert.ok(stderr.includes('\r\u001B[2K⊙ "Tab View - Co..." in tab-view-coverflow.yml [3/10]'));
    assert.ok(stderr.includes('\r\u001B[2K⊙ "Tab View - Co..." in tab-view-coverflow.yml [4/10]'));
    assert.ok(
      stderr.includes('\r\u001B[2K✓ "Tab View - Coverflow" in tab-view-coverflow.yml (17.8s)\n'),
    );
  } finally {
    if (typeof originalCi === 'string') process.env.CI = originalCi;
    else delete process.env.CI;
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse suppresses live progress outside interactive terminals', async () => {
  const socket = createMockSocket();
  const req: DaemonRequest = {
    session: 'default',
    command: 'test',
    positionals: ['/tmp/replays'],
    flags: {},
    token: 'secret',
    meta: { requestId: 'req-non-tty-progress', requestProgress: 'replay-test' },
  };
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = withStderrTerminal({ isTTY: false, columns: 53 }, () =>
      readSocketProgressResponse(socket, req),
    );
    const progress = JSON.stringify({
      type: 'progress',
      event: {
        type: 'replay-test',
        file: '/tmp/tab-view-coverflow.yml',
        title: 'Tab View - Coverflow',
        status: 'progress',
        index: 1,
        total: 1,
        attempt: 1,
        maxAttempts: 1,
        stepIndex: 3,
        stepTotal: 10,
      },
    });
    const pass = JSON.stringify({
      type: 'progress',
      event: {
        type: 'replay-test',
        file: '/tmp/tab-view-coverflow.yml',
        title: 'Tab View - Coverflow',
        status: 'pass',
        index: 1,
        total: 1,
        attempt: 1,
        maxAttempts: 1,
        durationMs: 17_800,
      },
    });
    const responseLine = JSON.stringify({
      type: 'response',
      response: { ok: true, data: { via: 'socket-progress' } },
    });

    socket.emit('data', `${progress}\n${pass}\n${responseLine}\n`);

    assert.deepEqual(await responsePromise, { ok: true, data: { via: 'socket-progress' } });
    assert.equal(stderr, '✓ "Tab View - Coverflow" in tab-view-coverflow.yml (17.8s)\n');
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse rejects invalid response lines with request context', async () => {
  const socket = createMockSocket();
  const req: DaemonRequest = {
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    token: 'secret',
    meta: { requestId: 'req-invalid-socket-progress' },
  };

  const responsePromise = readSocketProgressResponse(socket, req);
  socket.emit('data', '{not-json}\n');

  await assert.rejects(
    responsePromise,
    (error) =>
      error instanceof AppError &&
      error.code === 'COMMAND_FAILED' &&
      error.message === 'Invalid daemon response' &&
      error.details?.requestId === 'req-invalid-socket-progress' &&
      error.details?.line === '{not-json}',
  );
});
