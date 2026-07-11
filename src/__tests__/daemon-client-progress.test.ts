import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../daemon/types.ts';
import type { RequestProgressEvent } from '../request/progress.ts';
import { readDaemonSocketProgressResponse } from '../daemon/client/daemon-client-progress.ts';
import { AppError } from '../kernel/errors.ts';

type MockSocket = EventEmitter & {
  ended: boolean;
  encoding?: string;
  end: () => MockSocket;
  setEncoding: (encoding: BufferEncoding) => MockSocket;
};

type ReplayTestProgressEvent = Extract<RequestProgressEvent, { type: 'replay-test' }>;

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
  onProgress?: (event: RequestProgressEvent) => void,
): Promise<DaemonResponse> {
  let settled = false;
  return new Promise((resolve, reject) => {
    readDaemonSocketProgressResponse(socket as unknown as Socket, {
      req,
      onProgress,
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

function replayProgressLine(stepIndex: number): string {
  return JSON.stringify({
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
}

function replayPassLine(): string {
  return JSON.stringify({
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
}

function responseLine(data: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'response',
    response: { ok: true, data },
  });
}

function replayTestEvent(event: RequestProgressEvent | undefined): ReplayTestProgressEvent {
  assert.equal(event?.type, 'replay-test');
  return event as ReplayTestProgressEvent;
}

test('readDaemonSocketProgressResponse forwards split progress lines before response envelopes', async () => {
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
  const events: RequestProgressEvent[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = readSocketProgressResponse(socket, req, (event) => events.push(event));
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
    assert.equal(stderr, '');
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.type, 'replay-test');
    if (event?.type === 'replay-test') {
      assert.equal(event.title, 'Login flow');
    }
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse renders generic command progress', async () => {
  const socket = createMockSocket();
  const req: DaemonRequest = {
    session: 'default',
    command: 'snapshot',
    positionals: [],
    flags: {},
    token: 'secret',
    meta: { requestId: 'req-command-progress', requestProgress: 'command' },
  };
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = readSocketProgressResponse(socket, req);
    socket.emit(
      'data',
      `${JSON.stringify({
        type: 'progress',
        event: {
          type: 'command',
          status: 'progress',
          message: 'Building Apple runner...',
        },
      })}\n`,
    );
    socket.emit(
      'data',
      `${JSON.stringify({
        type: 'response',
        response: { ok: true, data: { via: 'command-progress' } },
      })}\n`,
    );

    assert.deepEqual(await responsePromise, { ok: true, data: { via: 'command-progress' } });
    assert.equal(stderr, 'Building Apple runner...\n');
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse forwards replay progress events to the sink', async () => {
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
  const events: RequestProgressEvent[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  try {
    (process.stderr as any).write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    const responsePromise = readSocketProgressResponse(socket, req, (event) => events.push(event));
    socket.emit(
      'data',
      [
        replayProgressLine(3),
        replayProgressLine(4),
        replayPassLine(),
        responseLine({ via: 'socket-progress' }),
      ].join('\n') + '\n',
    );

    assert.deepEqual(await responsePromise, { ok: true, data: { via: 'socket-progress' } });
    assert.equal(stderr, '');
    assert.deepEqual(
      events.map((event) => replayTestEvent(event).status),
      ['progress', 'progress', 'pass'],
    );
    assert.equal(replayTestEvent(events[0]).stepIndex, 3);
    assert.equal(replayTestEvent(events[1]).stepIndex, 4);
    assert.equal(replayTestEvent(events[2]).durationMs, 17_800);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('readDaemonSocketProgressResponse does not render replay progress without a sink', async () => {
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

    const responsePromise = readSocketProgressResponse(socket, req);
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
    assert.equal(stderr, '');
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
