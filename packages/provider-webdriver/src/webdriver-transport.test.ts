import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, test, vi } from 'vitest';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';
import {
  WebDriverTransport,
  isWebDriverConnectRefused,
  isWebDriverRequestTimeout,
  isWebDriverRouteUnsupported,
} from './webdriver-transport.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// The transport's own deadline must surface as a machine-readable reason, not
// as fetch's `AbortError`/`TimeoutError` DOMException name: the session manager
// keys its "the provider may still be creating a billed session" branch on
// `details.reason`, and a name-sniffing consumer would confuse it with a
// caller-driven cancellation (#1774).
test('a transport-deadline abort surfaces as a typed timeout, not a DOMException name', async () => {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30, retryAttempts: 0 },
  });
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });

  await assert.rejects(transport.requestValue('POST', '/session', {}), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.ok(isWebDriverRequestTimeout(error));
    assert.equal(error.details?.timeoutMs, 30);
    assert.equal(error.details?.method, 'POST');
    assert.equal(error.details?.path, '/session');
    return true;
  });
});

// A caller that cancels its own request keeps a caller-cancellation error —
// only the transport's deadline becomes a typed timeout. Otherwise a client
// disconnect during `POST /session` would read as a provider timeout and drive
// the wrong ownership branch.
test('a caller-driven abort is NOT reclassified as a transport timeout', async () => {
  const controller = new AbortController();
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 0 },
  });
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    });

  const pending = transport.requestValue('POST', '/session', {}, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('client disconnected'));

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isWebDriverRequestTimeout(error), false);
    return /client disconnected/.test(error instanceof Error ? error.message : String(error));
  });
});

test('cancels a retry delay when the request binding aborts', async () => {
  const controller = new AbortController();
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 1, retryDelayMs: 10_000 },
  });
  let calls = 0;
  let firstRequestObserved!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestObserved = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    firstRequestObserved();
    return new Response(JSON.stringify({ value: { message: 'grid unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const pending = transport.requestValue('GET', '/session/wd-1/source', undefined, {
    signal: controller.signal,
  });
  await firstRequest;
  // Let the failed response enter the retry sleep; aborting before retry policy
  // sees the 503 correctly preserves that primary transport failure instead.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('request cancelled during WebDriver retry'));

  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(calls, 1);
});

// AWS Device Farm's remote access endpoint sits in front of Appium and validates the request
// against the W3C protocol, where every POST body is a JSON object: a `POST /back` with no body
// came back as `Value null at 'payload' failed to satisfy constraint: Member must not be null`.
test('a POST without parameters carries an empty JSON object body', async () => {
  const seen: { method: string | undefined; contentType: string | undefined; body: string }[] = [];
  const driver = await localDriver((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      seen.push({ method: request.method, contentType: request.headers['content-type'], body });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value: null }));
    });
  });
  try {
    const transport = new WebDriverTransport({
      clientVersion: '0.0.0-test',
      endpoint: driver.endpoint,
      requestPolicy: { timeoutMs: 5_000, retryAttempts: 0 },
    });

    await transport.requestValue('POST', '/session/wd-1/back');
    await transport.requestValue('DELETE', '/session/wd-1/actions');
    await transport.requestValue('GET', '/session/wd-1/source');

    assert.deepEqual(seen, [
      { method: 'POST', contentType: 'application/json', body: '{}' },
      { method: 'DELETE', contentType: undefined, body: '' },
      { method: 'GET', contentType: undefined, body: '' },
    ]);
  } finally {
    await driver.close();
  }
});

/** A 127.0.0.1 port nothing listens on: bound, then released. */
async function refusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A local driver whose every request runs `handle`; `requests` counts what reached it. */
async function localDriver(
  handle: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ endpoint: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/wd/hub/`,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Counts fetch calls while the real fetch still produces the real network failure. */
function countFetchCalls(): () => number {
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    return await realFetch(input, init);
  };
  return () => calls;
}

// A refused connection was never established, so no byte of the request reached the driver. A
// GET read keeps its retry.
test('a refused connection discloses the request never reached the driver', async () => {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: `http://127.0.0.1:${await refusedPort()}/wd/hub/`,
    requestPolicy: { timeoutMs: 5_000, retryDelayMs: 1 },
  });
  const calls = countFetchCalls();

  await assert.rejects(transport.requestValue('GET', '/session/wd-1/source'), (error: unknown) => {
    assert.ok(isWebDriverConnectRefused(error));
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(calls(), 2);
});

// A POST may change device state, so it gets one attempt whichever failure it hit.
test('a refused POST is not resent', async () => {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: `http://127.0.0.1:${await refusedPort()}/wd/hub/`,
    requestPolicy: { timeoutMs: 5_000, retryDelayMs: 1 },
  });
  const calls = countFetchCalls();

  await assert.rejects(transport.requestValue('POST', '/session/wd-1/actions', {}));
  assert.equal(calls(), 1);
});

// The driver read the whole body before the socket reset, so it may have acted on it.
test('a socket reset after the driver read the body discloses an unresolved outcome', async () => {
  const driver = await localDriver((request) => {
    request.resume();
    request.on('end', () => request.socket.destroy());
  });
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: driver.endpoint,
    requestPolicy: { timeoutMs: 5_000, retryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      transport.requestValue('POST', '/session/wd-1/actions', { actions: [] }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(isWebDriverConnectRefused(error), false);
        assert.equal(error.details?.dispatched, 'unknown');
        return true;
      },
    );
    assert.equal(driver.requests(), 1);
  } finally {
    await driver.close();
  }
});

// The status line arrived, so the driver received the request before the body was cut off.
test('a response body cut off after the headers discloses an unresolved outcome', async () => {
  const driver = await localDriver((request, response) => {
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    response.write('{"value":', () => request.socket.destroy());
  });
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: driver.endpoint,
    requestPolicy: { timeoutMs: 5_000, retryDelayMs: 1 },
  });

  try {
    await assert.rejects(
      transport.requestValue('POST', '/session/wd-1/keys', { value: ['a'] }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(isWebDriverConnectRefused(error), false);
        assert.equal(error.details?.dispatched, 'unknown');
        return true;
      },
    );
    assert.equal(driver.requests(), 1);
  } finally {
    await driver.close();
  }
});

// A 5xx means the driver answered — it received and processed the request —
// but not whether the mutation it described completed before it failed.
test('a 5xx response to a POST discloses an unresolved outcome and is not resent', async () => {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 1, retryDelayMs: 1 },
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ value: { message: 'grid unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    transport.requestValue('POST', '/session/wd-1/actions', {}),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, 'unknown');
      return true;
    },
  );
  assert.equal(calls, 1);
});

const ROUTE_ANSWERS: readonly { status: number; body: unknown; unsupported: boolean }[] = [
  { status: 404, body: { value: { error: 'unknown command', message: 'x' } }, unsupported: true },
  { status: 405, body: { value: { error: 'unknown method', message: 'x' } }, unsupported: true },
  { status: 404, body: {}, unsupported: true },
  { status: 405, body: {}, unsupported: true },
  { status: 501, body: {}, unsupported: true },
  {
    status: 404,
    body: { value: { error: 'invalid session id', message: 'x' } },
    unsupported: false,
  },
  { status: 405, body: { value: { error: 'timeout', message: 'x' } }, unsupported: false },
  { status: 501, body: { value: { error: 'unknown error', message: 'x' } }, unsupported: false },
  { status: 500, body: {}, unsupported: false },
  { status: 403, body: {}, unsupported: false },
];

// A W3C error code decides when present; without one, a bare 404, 405, or 501 is the driver
// saying it does not implement the route.
for (const { status, body, unsupported } of ROUTE_ANSWERS) {
  test(`HTTP ${status} ${JSON.stringify(body)} is ${unsupported ? '' : 'not '}an unsupported route`, async () => {
    const transport = new WebDriverTransport({
      clientVersion: '0.0.0-test',
      endpoint: 'http://cloud-webdriver.test/wd/hub/',
    });
    globalThis.fetch = async () => Response.json(body, { status });

    await withDiagnosticsScope({ command: 'back' }, async () => {
      await assert.rejects(
        transport.requestValue('POST', '/session/wd-1/back'),
        (error: unknown) => {
          assert.equal(isWebDriverRouteUnsupported(error), unsupported);
          if (unsupported) assert.equal((error as AppError).details?.dispatched, 'no');
          return true;
        },
      );
      await vi.waitFor(() =>
        assert.equal(
          countDiagnosticEventsByPhase(['webdriver_route_unsupported']),
          unsupported ? 1 : 0,
        ),
      );
    });
  });
}

/** The shape undici rejects with: `TypeError('fetch failed')` whose `cause` holds the socket error. */
function fetchFailedWith(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause });
}

function socketError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** `socketError(code)` wrapped in `layers` code-less errors, so the code sits `layers + 1` causes down. */
function nestedCause(code: string, layers: number): Error {
  let error = socketError(code);
  for (let layer = 0; layer < layers; layer += 1) error = new Error('wrapped', { cause: error });
  return error;
}

async function dispatchedAfter(failure: TypeError): Promise<unknown> {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
  });
  globalThis.fetch = async () => {
    throw failure;
  };
  try {
    await transport.requestValue('POST', '/session/wd-1/actions', {});
  } catch (error) {
    return (error as AppError).details?.dispatched;
  }
  throw new Error('the request did not fail');
}

// Happy-eyeballs connects surface as an AggregateError over every address tried. One address that
// connected and then reset means the request may have reached the driver.
test('an AggregateError discloses no only when every member failed before connecting', async () => {
  const allRefused = new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNREFUSED')]);
  const oneReset = new AggregateError([socketError('ECONNREFUSED'), socketError('ECONNRESET')]);

  assert.equal(await dispatchedAfter(fetchFailedWith(allRefused)), 'no');
  assert.equal(await dispatchedAfter(fetchFailedWith(oneReset)), 'unknown');
});

// The cause chain is read to depth 4 below the thrown error. A code further down is not read, and
// a failure with no readable code never proves the request stayed off the wire.
test('a pre-connect code is read to the depth cap and not beyond', async () => {
  assert.equal(await dispatchedAfter(fetchFailedWith(nestedCause('ECONNREFUSED', 3))), 'no');
  assert.equal(await dispatchedAfter(fetchFailedWith(nestedCause('ECONNREFUSED', 4))), 'unknown');
});

// contracts/fixtures/dispatch-disclosure.json, webdriver rows: each sends a mutating POST through the
// real transport and fetch to a local socket, and asserts the `details.dispatched` it fails with.

async function postActions(endpoint: string, timeoutMs = 5_000): Promise<unknown> {
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint,
    requestPolicy: { timeoutMs, retryDelayMs: 1 },
  });
  return await transport.requestValue('POST', '/session/wd-1/actions', { actions: [] });
}

async function postToRefusedPort(): Promise<unknown> {
  return await postActions(`http://127.0.0.1:${await refusedPort()}/wd/hub/`);
}

async function postThatTimesOutAfterSend(): Promise<unknown> {
  const driver = await localDriver((request) => request.resume());
  try {
    return await postActions(driver.endpoint, 50);
  } finally {
    assert.equal(driver.requests(), 1);
    await driver.close();
  }
}

async function postAnswered5xx(): Promise<unknown> {
  const driver = await localDriver((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ value: { error: 'unknown error', message: 'grid down' } }));
    });
  });
  try {
    return await postActions(driver.endpoint);
  } finally {
    assert.equal(driver.requests(), 1);
    await driver.close();
  }
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'webdriver.connect-refused': postToRefusedPort,
  'webdriver.timeout-after-send': postThatTimesOutAfterSend,
  'webdriver.http-5xx-after-send': postAnswered5xx,
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every webdriver dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      return true;
    });
  });
}
