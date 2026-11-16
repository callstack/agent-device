import assert from 'node:assert/strict';
import { once } from 'node:events';
import http, { type ClientRequest, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { expect, onTestFinished, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createNodeTransferFetch, settleUpstreamFetch } from './transfer-transport.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function controlledClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function observeRequest(inspect?: (request: ClientRequest) => void) {
  const original = http.request;
  const made = deferred<ClientRequest>();
  const closed = deferred<void>();
  const spy = vi.spyOn(http, 'request').mockImplementation((...args) => {
    const req = Reflect.apply(original, http, args) as ClientRequest;
    req.once('close', () => closed.resolve());
    inspect?.(req);
    made.resolve(req);
    return req;
  });
  onTestFinished(() => spy.mockRestore());
  return { made: made.promise, closed: closed.promise };
}

function phaseFailure(error: unknown, phase: string, timeoutMs: number) {
  assert.ok(error instanceof AppError);
  expect(error.details).toEqual({
    reason: 'transfer_phase_timeout',
    transferPhase: phase,
    timeoutMs,
  });
}

function emptyChunkFlood(caller: AbortController, reason: Error) {
  const limit = 1_024;
  let reads = 0;
  let readsAtAbort = limit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (reads === 0) {
          timer = setTimeout(() => {
            readsAtAbort = reads;
            caller.abort(reason);
          }, 0);
        }
        if (reads === limit) controller.close();
        else {
          reads += 1;
          controller.enqueue(new Uint8Array());
        }
      },
    },
    { highWaterMark: 0 },
  );
  onTestFinished(() => clearTimeout(timer));
  return { body, limit, readsAtAbort: () => readsAtAbort };
}

test('empty upload chunks yield to caller cancellation before the bounded flood ends', async () => {
  const origin = await upstream((req) => req.resume());
  const observed = observeRequest();
  const caller = new AbortController();
  const reason = new Error('cancel upload while empty chunks are ready');
  const flood = emptyChunkFlood(caller, reason);
  const pending = createNodeTransferFetch()(
    new Request(`${origin}/upload/direct/ticket`, {
      method: 'PUT',
      body: flood.body,
      signal: caller.signal,
      duplex: 'half',
    } as RequestInit),
  );
  await expect(pending).rejects.toBe(reason);
  await observed.closed;
  expect(flood.readsAtAbort()).toBeLessThan(flood.limit);
  expect(flood.body.locked).toBe(false);
});

test('empty custom response chunks yield to caller cancellation before the bounded flood ends', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel response while empty chunks are ready');
  const flood = emptyChunkFlood(caller, reason);
  const response = await settleUpstreamFetch(
    async () => new Response(flood.body),
    new Request('http://daemon.internal/artifacts/build', { signal: caller.signal }),
  );
  await expect(response.arrayBuffer()).rejects.toBe(reason);
  expect(flood.readsAtAbort()).toBeLessThan(flood.limit);
  expect(flood.body.locked).toBe(false);
});

test('finite empty chunks preserve the following upload and custom response bytes', async () => {
  const emptyPrefix = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode('payload intact'));
        controller.close();
      },
    });
  const origin = await upstream((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => res.end(text));
  });
  const uploaded = await createNodeTransferFetch()(
    new Request(`${origin}/upload/direct/ticket`, {
      method: 'PUT',
      body: emptyPrefix(),
      duplex: 'half',
    } as RequestInit),
  );
  expect(await uploaded.text()).toBe('payload intact');
  const custom = await settleUpstreamFetch(
    async () => new Response(emptyPrefix()),
    new Request('http://daemon.internal/artifacts/build'),
  );
  expect(await custom.text()).toBe('payload intact');
});

test.each([401, 413, 200, 204])(
  'an early %s stops and unlocks an endless incoming reader before disposal',
  async (status) => {
    const origin = await upstream((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(status === 204 ? undefined : 'accepted answer');
    });
    controlledClock();
    const observed = observeRequest();
    const waiting = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        pull() {
          waiting.resolve();
          return new Promise<void>(() => undefined);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await createNodeTransferFetch()(
      new Request(`${origin}/upload/direct/ticket`, {
        method: 'PUT',
        body,
        duplex: 'half',
      } as RequestInit),
    );
    await waiting.promise;
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(status === 204 ? '' : 'accepted answer');
    await observed.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(false);
    expect((await observed.made).closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('a progressing upload gets a fresh header ceiling at actual finish, beyond thirty seconds', async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const receivedEnd = deferred<void>();
  let bytes = 0;
  const origin = await upstream((req) => {
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes >= 1) first.resolve();
      if (bytes >= 2) second.resolve();
    });
    req.once('end', () => receivedEnd.resolve());
  });
  controlledClock();
  const observed = observeRequest();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        producer = controller;
      },
    },
    { highWaterMark: 0 },
  );
  let settled = false;
  const result = createNodeTransferFetch()(
    new Request(`${origin}/upload/direct/ticket`, {
      method: 'PUT',
      body,
      duplex: 'half',
    } as RequestInit),
  ).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  producer.enqueue(new Uint8Array([1]));
  await first.promise;
  await vi.advanceTimersByTimeAsync(31_000);
  expect(settled).toBe(false);
  producer.enqueue(new Uint8Array([2]));
  await second.promise;
  const req = await observed.made;
  const finished = once(req, 'finish');
  producer.close();
  await finished;
  await receivedEnd.promise;
  expect(req.writableFinished).toBe(true);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(req.destroyed).toBe(true);
  phaseFailure(await result, 'response-headers', 30_000);
  await observed.closed;
  expect(vi.getTimerCount()).toBe(0);
});

test('a bodyless request starts its header ceiling after actual finish on a connected socket', async () => {
  const entered = deferred<void>();
  const origin = await upstream(() => entered.resolve());
  controlledClock();
  const observed = observeRequest();
  const result = createNodeTransferFetch()(new Request(`${origin}/artifacts/build`)).catch(
    (error: unknown) => error,
  );
  await entered.promise;
  expect((await observed.made).writableFinished).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await observed.made).destroyed).toBe(true);
  phaseFailure(await result, 'response-headers', 30_000);
  await observed.closed;
  expect(vi.getTimerCount()).toBe(0);
});

test('response inactivity charges a pending producer, then joins its owned request close', async () => {
  const origin = await upstream((_req, res) => res.flushHeaders());
  controlledClock();
  const observed = observeRequest();
  const response = await createNodeTransferFetch()(new Request(`${origin}/artifacts/build`));
  const result = response.text().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(119_999);
  expect((await observed.made).destroyed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await observed.made).destroyed).toBe(true);
  phaseFailure(await result, 'response-body', 120_000);
  await observed.closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(vi.getTimerCount()).toBe(0);
});

test('downstream backpressure suspends response inactivity without suspending the aggregate', async () => {
  const peer = deferred<ServerResponse>();
  const origin = await upstream((_req, res) => {
    res.flushHeaders();
    peer.resolve(res);
  });
  controlledClock();
  const response = await createNodeTransferFetch()(new Request(`${origin}/artifacts/build`));
  await vi.advanceTimersByTimeAsync(240_000);
  (await peer.promise).end('available on demand');
  expect(await response.text()).toBe('available on demand');
  expect(vi.getTimerCount()).toBe(0);
});

test('continuous response progress cannot refresh the six hundred second aggregate', async () => {
  const peer = deferred<ServerResponse>();
  const origin = await upstream((_req, res) => {
    res.flushHeaders();
    peer.resolve(res);
  });
  controlledClock();
  const observed = observeRequest();
  const response = await createNodeTransferFetch()(new Request(`${origin}/artifacts/build`));
  const reader = response.body!.getReader();
  const res = await peer.promise;
  for (let index = 0; index < 5; index += 1) {
    const reading = reader.read();
    await vi.advanceTimersByTimeAsync(110_000);
    res.write(Buffer.from([index + 1]));
    const chunk = await reading;
    expect(chunk.done).toBe(false);
    expect(Array.from(chunk.value!)).toEqual([index + 1]);
  }
  const failure = reader.read().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(50_000);
  expect((await observed.made).destroyed).toBe(true);
  const error = await failure;
  assert.ok(error instanceof AppError);
  expect(error.details).toEqual({
    reason: 'transfer_forwarding_deadline_exceeded',
    transferPhase: 'forwarding',
    timeoutMs: 600_000,
  });
  await observed.closed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['caller', 'idle', 'aggregate'] as const)(
  'ignored foreign read and cancel cannot hold proxy settlement after %s expiry',
  async (expiry) => {
    controlledClock();
    const caller = new AbortController();
    const reading = deferred<void>();
    const cancelled = deferred<unknown>();
    const lateRead = deferred<void>();
    const lateCancel = deferred<void>();
    const foreign = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
          return lateRead.promise;
        },
        cancel(reason) {
          cancelled.resolve(reason);
          return lateCancel.promise;
        },
      },
      { highWaterMark: 0 },
    );
    let bounded: Request | undefined;
    const response = await settleUpstreamFetch(
      async (request) => {
        bounded = request;
        return new Response(foreign);
      },
      new Request('http://daemon.internal/artifacts/build', { signal: caller.signal }),
    );
    if (expiry === 'aggregate') await vi.advanceTimersByTimeAsync(500_000);
    let settled = false;
    const result = response.text().catch((error: unknown) => error);
    void result.then(() => {
      settled = true;
    });
    await reading.promise;
    const callerReason = new AppError('COMMAND_FAILED', 'Caller stopped waiting', {
      reason: 'client_gone',
    });
    if (expiry === 'caller') caller.abort(callerReason);
    else if (expiry === 'idle') await vi.advanceTimersByTimeAsync(120_000);
    else await vi.advanceTimersByTimeAsync(100_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    const error = await result;
    if (expiry === 'idle') phaseFailure(error, 'response-body', 120_000);
    else if (expiry === 'caller') expect(error).toBe(callerReason);
    else {
      assert.ok(error instanceof AppError);
      expect(error.details).toEqual({
        reason: 'transfer_forwarding_deadline_exceeded',
        transferPhase: 'forwarding',
        timeoutMs: 600_000,
      });
    }
    expect(await cancelled.promise).toBe(error);
    expect(bounded?.signal.reason).toBe(error);
    expect(foreign.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    lateRead.reject(new Error('late foreign producer rejection'));
    lateCancel.reject(new Error('late foreign cancel rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
);

test('the aggregate cancels an undemanded foreign body without joining its opaque cancel', async () => {
  controlledClock();
  const cancelled = deferred<unknown>();
  const response = await settleUpstreamFetch(
    async () =>
      new Response(
        new ReadableStream(
          {
            cancel(reason) {
              cancelled.resolve(reason);
              return new Promise<void>(() => undefined);
            },
          },
          { highWaterMark: 0 },
        ),
      ),
    new Request('http://daemon.internal/artifacts/build'),
  );
  await vi.advanceTimersByTimeAsync(600_000);
  const error = await response.text().catch((error: unknown) => error);
  assert.ok(error instanceof AppError);
  expect(error.details).toEqual({
    reason: 'transfer_forwarding_deadline_exceeded',
    transferPhase: 'forwarding',
    timeoutMs: 600_000,
  });
  expect(await cancelled.promise).toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['throw', 'reject'] as const)(
  'a synchronous custom %s releases all exchange timers',
  async (kind) => {
    controlledClock();
    const reason = new Error('custom transport failed');
    const pending = settleUpstreamFetch(() => {
      if (kind === 'throw') throw reason;
      return Promise.reject(reason);
    }, new Request('http://daemon.internal/artifacts/build'));
    await expect(pending).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test('an already aborted request never starts foreign work or leaves a timer', async () => {
  controlledClock();
  const reason = new Error('already stopped');
  let calls = 0;
  await expect(
    settleUpstreamFetch(
      async () => {
        calls += 1;
        return new Response('unexpected');
      },
      new Request('http://daemon.internal/artifacts/build', { signal: AbortSignal.abort(reason) }),
    ),
  ).rejects.toBe(reason);
  expect(calls).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('late custom response and rejection outcomes stay observed after cancellation', async () => {
  const unhandled: unknown[] = [];
  const rejected = (error: unknown) => {
    unhandled.push(error);
  };
  process.on('unhandledRejection', rejected);
  onTestFinished(() => {
    process.off('unhandledRejection', rejected);
  });
  const caller = new AbortController();
  const late = deferred<Response>();
  const cancelled = deferred<void>();
  const pending = settleUpstreamFetch(
    () => late.promise,
    new Request('http://daemon.internal/artifacts/build', { signal: caller.signal }),
  );
  const reason = new Error('stopped');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  late.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.resolve();
        },
      }),
    ),
  );
  await cancelled.promise;
  const rejection = deferred<Response>();
  const other = new AbortController();
  const failed = settleUpstreamFetch(
    () => rejection.promise,
    new Request('http://daemon.internal/artifacts/build', { signal: other.signal }),
  );
  other.abort(reason);
  await expect(failed).rejects.toBe(reason);
  rejection.reject(new Error('late tunnel failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(unhandled).toEqual([]);
});

test.each(['abort', 'peer-close', 'drain', 'idle', 'drain-only'] as const)(
  'an actual blocked write releases its drain wait on %s',
  async (outcome) => {
    const entered = deferred<http.IncomingMessage>();
    const origin = await upstream((req, res) => {
      req.pause();
      entered.resolve(req);
      req.once('end', () => res.end('upload complete'));
    });
    controlledClock();
    const blocked = deferred<void>();
    let drains = 0;
    const observed = observeRequest((req) => {
      const onDrain = () => {
        drains += 1;
      };
      req.on('drain', onDrain);
      onTestFinished(() => {
        req.off('drain', onDrain);
      });
      const write = req.write;
      req.write = function (this: ClientRequest, ...args: unknown[]): boolean {
        const accepted = Reflect.apply(write, this, args) as boolean;
        if (!accepted) blocked.resolve();
        return accepted;
      };
    });
    const caller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024 * 1024));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const result = createNodeTransferFetch()(
      new Request(`${origin}/upload/direct/ticket`, {
        method: 'PUT',
        body,
        signal: caller.signal,
        duplex: 'half',
      } as RequestInit),
    ).catch((error: unknown) => error);
    await blocked.promise;
    const incoming = await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const req = await observed.made;
    expect(req.writableNeedDrain).toBe(true);
    expect(req.writableLength).toBeGreaterThan(0);
    expect(req.listenerCount('drain')).toBe(2); // The probe and the adapter's actual wait.
    let destroyedAtOriginalDeadline = false;
    const reason = new Error('client left during backpressure');
    if (outcome === 'abort') caller.abort(reason);
    else if (outcome === 'peer-close') incoming.destroy();
    else if (outcome === 'idle') await vi.advanceTimersByTimeAsync(120_000);
    else if (outcome === 'drain-only') {
      await vi.advanceTimersByTimeAsync(60_000);
      req.emit('drain');
      expect(req.writableLength).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000);
      destroyedAtOriginalDeadline = req.destroyed;
      await vi.advanceTimersByTimeAsync(120_000);
    } else incoming.resume();
    const response = await result;
    if (outcome === 'drain') {
      assert.ok(response instanceof Response);
      expect(await response.text()).toBe('upload complete');
      expect(drains).toBeGreaterThan(0);
    } else if (outcome === 'abort') expect(response).toBe(reason);
    else if (outcome === 'idle' || outcome === 'drain-only')
      phaseFailure(response, 'request-body', 120_000);
    else expect(response).toBeInstanceOf(Error);
    await observed.closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(req.listenerCount('drain')).toBe(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'drain-only') expect(destroyedAtOriginalDeadline).toBe(true);
  },
);

test('a completed exchange leaves its global-agent socket available to the next request', async () => {
  const sockets: http.IncomingMessage['socket'][] = [];
  const origin = await upstream((req, res) => {
    sockets.push(req.socket);
    res.end('pooled response');
  });
  const requests: ClientRequest[] = [];
  observeRequest((req) => {
    requests.push(req);
  });
  const send = createNodeTransferFetch();
  expect(await (await send(new Request(`${origin}/artifacts/first`))).text()).toBe(
    'pooled response',
  );
  expect(sockets[0]?.destroyed).toBe(false);
  expect(await (await send(new Request(`${origin}/artifacts/second`))).text()).toBe(
    'pooled response',
  );
  expect(requests[1]?.reusedSocket).toBe(true);
  expect(sockets[1]).toBe(sockets[0]);
  expect(sockets[1]?.destroyed).toBe(false);
});

test('a real TCP connection without a completed TLS handshake expires in the connect phase', async () => {
  const accepted = deferred<void>();
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    accepted.resolve();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  controlledClock();
  const port = (server.address() as AddressInfo).port;
  const result = createNodeTransferFetch()(
    new Request(`https://127.0.0.1:${port}/artifacts/build`),
  ).catch((error: unknown) => error);
  await accepted.promise;
  await vi.advanceTimersByTimeAsync(30_000);
  phaseFailure(await result, 'connect', 30_000);
  expect(vi.getTimerCount()).toBe(0);
});

test('downstream body cancellation aborts the custom request without joining an ignored cancel callback', async () => {
  controlledClock();
  const reading = deferred<void>();
  const cancelled = deferred<unknown>();
  let bounded!: Request;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reading.resolve();
        return new Promise<void>(() => undefined);
      },
      cancel(reason) {
        cancelled.resolve(reason);
        return new Promise<void>(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  const response = await settleUpstreamFetch(async (request) => {
    bounded = request;
    return new Response(body);
  }, new Request('http://daemon.internal/artifacts/build'));
  const reader = response.body!.getReader();
  const pending = reader.read();
  await reading.promise;
  const reason = new Error('downstream stopped reading');
  await reader.cancel(reason);
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(await cancelled.promise).toBe(reason);
  expect(bounded.signal.reason).toBe(reason);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(['iterator stop', 'request close', 'outgoing pump'] as const)(
  'owned cleanup awaits %s before settlement and timer disposal',
  async (held) => {
    const origin = await upstream((_req, res) => {
      res.setHeader('connection', 'close');
      res.end('joined');
    });
    controlledClock();
    const stopEntered = deferred<void>();
    const responseClosed = deferred<void>();
    const pumpUnlocked = deferred<void>();
    const pumpStopEntered = deferred<void>();
    const allowPump = deferred<void>();
    const allowStop = deferred<void>();
    const closeEntered = deferred<void>();
    const allowClose = deferred<void>();
    onTestFinished(() => {
      allowStop.resolve();
      allowClose.resolve();
      allowPump.resolve();
    });
    let unlocked = false;
    const observed = observeRequest((req) => {
      const once = req.once;
      const closeRegistration = vi.spyOn(req, 'once').mockImplementation((event, listener) => {
        if (event !== 'close') return Reflect.apply(once, req, [event, listener]);
        closeRegistration.mockRestore();
        return Reflect.apply(once, req, [
          event,
          (...args: unknown[]) => {
            closeEntered.resolve();
            if (held === 'request close')
              void allowClose.promise.then(() => Reflect.apply(listener, req, args));
            else Reflect.apply(listener, req, args);
          },
        ]);
      });
      onTestFinished(() => closeRegistration.mockRestore());
      req.prependListener('response', (res) => {
        res.once('close', () => responseClosed.resolve());
        const iterate = res[Symbol.asyncIterator].bind(res);
        res[Symbol.asyncIterator] = () => {
          const iterator = iterate();
          const stop = iterator.return!.bind(iterator);
          iterator.return = async (value) => {
            const stopped = await stop(value);
            stopEntered.resolve();
            if (held === 'iterator stop') await allowStop.promise;
            return stopped;
          };
          return iterator;
        };
      });
      if (held === 'outgoing pump') queueMicrotask(() => req.flushHeaders());
    });
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (held !== 'outgoing pump') controller.enqueue(new Uint8Array([1]));
        },
      },
      { highWaterMark: 0 },
    );
    const getReader = body.getReader.bind(body);
    body.getReader = (() => {
      const reader = getReader();
      const release = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        release();
        unlocked = true;
        pumpUnlocked.resolve();
      };
      if (held === 'outgoing pump') {
        const add = AbortSignal.prototype.addEventListener;
        const registration = vi
          .spyOn(AbortSignal.prototype, 'addEventListener')
          .mockImplementation(function (this: AbortSignal, event, listener, options) {
            registration.mockRestore();
            expect(event).toBe('abort');
            return Reflect.apply(add, this, [
              event,
              (value: Event) => {
                pumpStopEntered.resolve();
                void allowPump.promise.then(() => {
                  if (typeof listener === 'function') listener.call(this, value);
                  else listener?.handleEvent(value);
                });
              },
              options,
            ]);
          });
        onTestFinished(() => registration.mockRestore());
      }
      return reader;
    }) as typeof body.getReader;
    const response = await createNodeTransferFetch()(
      new Request(`${origin}/upload/direct/ticket`, {
        method: 'PUT',
        body,
        duplex: 'half',
      } as RequestInit),
    );
    let settled = false;
    const result = response.text().then((text) => {
      settled = true;
      return text;
    });
    await {
      'iterator stop': stopEntered.promise,
      'request close': closeEntered.promise,
      'outgoing pump': pumpStopEntered.promise,
    }[held];
    await Promise.all([observed.closed, responseClosed.promise]);
    if (held !== 'outgoing pump') await pumpUnlocked.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unlocked).toBe(held !== 'outgoing pump');
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    allowStop.resolve();
    allowClose.resolve();
    allowPump.resolve();
    expect(await result).toBe('joined');
    await pumpUnlocked.promise;
    expect(unlocked).toBe(true);
    await observed.closed;
    expect(vi.getTimerCount()).toBe(0);
  },
);
