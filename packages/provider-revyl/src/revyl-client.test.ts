import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createRevylClient,
  REVYL_DEFAULT_BACKEND_URL,
  resolveRevylBackendUrl,
  type RevylClient,
} from './revyl-client.ts';

test('uses the public Revyl backend when no URL is configured', () => {
  assert.equal(REVYL_DEFAULT_BACKEND_URL, 'https://backend.revyl.ai');
  assert.equal(resolveRevylBackendUrl('https://backend.revyl.ai/'), REVYL_DEFAULT_BACKEND_URL);
  // A client built without a URL calls that origin, so a fingerprint or a request never ends up with
  // a second, differently-spelled default.
  const client = createRevylClient({
    apiKey: 'test-key',
    clientVersion: '0.0.0-test',
    fetch: stubFetch(() => jsonResponse({ uuid: 'user-1' })),
  });
  assert.equal(client.backendUrl, REVYL_DEFAULT_BACKEND_URL);
});

test('keeps plain HTTP only on loopback', () => {
  assert.equal(resolveRevylBackendUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(resolveRevylBackendUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.throws(
    () => resolveRevylBackendUrl('http://backend.revyl.ai'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'invalid_provider_url',
  );
});

test('refuses an URL that carries credentials, a query, or a fragment', () => {
  for (const value of [
    'https://key@backend.revyl.ai',
    'https://backend.revyl.ai/?key=secret',
    'https://backend.revyl.ai#token',
    'not a url',
  ]) {
    assert.throws(
      () => resolveRevylBackendUrl(value),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'invalid_provider_url',
      value,
    );
  }
});

test('sends the credentials and attribution headers on every call', async () => {
  const calls: Request[] = [];
  const client = clientResponding(() => jsonResponse({ success: true }), calls);

  await client.workerAction('run-1', 'tap', { x: 1, y: 2 });
  await client.verifyCredentials();

  const action = calls[0]!;
  assert.equal(action.method, 'POST');
  assert.equal(action.headers.get('authorization'), 'Bearer test-key');
  assert.equal(action.headers.get('user-agent'), 'agent-device/0.0.0-test');
  assert.equal(action.headers.get('x-revyl-client'), 'agent-device');
  assert.equal(action.headers.get('x-revyl-agent'), 'agent-device');
  assert.equal(action.headers.get('content-type'), 'application/json');
  // An execution-API call is not a device action, so Revyl is not told a driver is behind it.
  assert.equal(calls[1]!.headers.get('x-revyl-agent'), null);
});

test('reads the typed failure one status names, on the route that answered', async () => {
  const cases: ReadonlyArray<
    Readonly<{
      status: number;
      reason: string;
      code: string;
      call: (client: RevylClient) => Promise<unknown>;
    }>
  > = [
    {
      status: 401,
      reason: 'provider-auth-rejected',
      code: 'UNAUTHORIZED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      status: 403,
      reason: 'provider-auth-rejected',
      code: 'UNAUTHORIZED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      // A 404 on a session route is Revyl's own "no such session", which is what a release of an
      // already-ended session has to read as.
      status: 404,
      reason: 'provider-session-gone',
      code: 'SESSION_NOT_FOUND',
      call: async (client) => await client.stopDeviceSession('session-1'),
    },
    {
      status: 410,
      reason: 'provider-session-gone',
      code: 'SESSION_NOT_FOUND',
      call: async (client) => await client.cancelDeviceRun('run-1'),
    },
    {
      // The same status on a route that names no session is a request the backend did not route.
      status: 404,
      reason: 'provider-request-failed',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      status: 409,
      reason: 'provider-conflict',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      status: 400,
      reason: 'provider-request-failed',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      // A timeout and any server failure leave the verdict unknown, which the caller must not retry
      // blindly.
      status: 408,
      reason: 'provider-unconfirmed',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      status: 500,
      reason: 'provider-unconfirmed',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.verifyCredentials(),
    },
    {
      // 503 is Revyl's "worker not attached", so it is both uncertain and replayable: the matrix
      // reads the verdict, the retry rule reads the replay. A POST keeps this at one attempt.
      status: 503,
      reason: 'provider-unconfirmed',
      code: 'COMMAND_FAILED',
      call: async (client) => await client.workerAction('run-1', 'tap', { x: 1, y: 2 }),
    },
  ];

  for (const testCase of cases) {
    const client = clientResponding(() => jsonError(testCase.status, 'nope'));
    await assert.rejects(
      async () => await testCase.call(client),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === testCase.code &&
        error.details?.reason === testCase.reason &&
        error.details?.providerStatus === testCase.status &&
        error.details?.providerDetail === 'nope',
      `HTTP ${testCase.status}`,
    );
  }
});

test('a status that left the verdict unknown says so in the hint', async () => {
  const client = clientResponding(() => jsonError(502, 'gateway down'));
  await assert.rejects(
    async () => await client.verifyCredentials(),
    (error: unknown) =>
      error instanceof AppError &&
      typeof error.details?.hint === 'string' &&
      error.details.hint.includes('may have landed'),
  );
});

test('replays a retried GET and never a side-effecting action', async () => {
  let attempts = 0;
  const client = clientResponding(() => {
    attempts += 1;
    return jsonError(503, 'worker busy');
  });
  await assert.rejects(async () => await client.getWorkerHierarchy('run-1'));
  assert.equal(attempts, 3, 'a read the runtime waits on once is retried on transient statuses');

  attempts = 0;
  const action = clientResponding(() => {
    attempts += 1;
    return jsonError(503, 'worker busy');
  });
  await assert.rejects(async () => await action.workerAction('run-1', 'tap', { x: 1, y: 2 }));
  assert.equal(attempts, 1, 'a tap is never replayed: it may already have landed');
});

test('a readiness read answers the polling loop on its first attempt', async () => {
  // The readiness loop owns the poll beat and the deadline, so a transport replay in front of these
  // two would hide Revyl's not-ready answer and stall the very wait being polled for.
  for (const read of [
    async (client: RevylClient) => await client.getWorkerHealth('run-1'),
    async (client: RevylClient) => await client.getWorkerConnection('run-1'),
  ]) {
    let attempts = 0;
    const client = clientResponding(() => {
      attempts += 1;
      return jsonError(503, 'worker not attached');
    });
    await assert.rejects(async () => await read(client));
    assert.equal(attempts, 1, 'the poll sees the answer, not a replay of it');
  }
});

test('a lifecycle stop that Revyl answers with a refusal is still a refusal', async () => {
  const stopped = clientResponding(() =>
    jsonResponse({ success: false, request_accepted: true, message: 'device busy' }),
  );
  await assert.rejects(
    async () => await stopped.stopDeviceSession('session-1'),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-refused' &&
      error.details?.operation === 'stop' &&
      error.message.includes('device busy'),
  );

  const unaccepted = clientResponding(() =>
    jsonResponse({ success: true, request_accepted: false }),
  );
  await assert.rejects(
    async () => await unaccepted.stopDeviceSession('session-1'),
    (error: unknown) => error instanceof AppError && error.details?.reason === 'provider-refused',
  );

  const canceled = clientResponding(() => jsonResponse({ success: false }));
  await assert.rejects(
    async () => await canceled.cancelDeviceRun('run-1'),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'provider-refused' &&
      error.details?.operation === 'cancel',
  );
});

test('a confirmed lifecycle stop reports the session Revyl ended', async () => {
  const client = clientResponding(() =>
    jsonResponse({ success: true, request_accepted: true, session_id: 'session-1' }),
  );
  assert.deepEqual(await client.stopDeviceSession('session-1'), {
    success: true,
    request_accepted: true,
    session_id: 'session-1',
  });
});

test('a device-proxy action refused inside a 200 body is refused', async () => {
  for (const body of [
    { success: false, error: 'invalid coordinates' },
    // `install` is the action that spells its verdict with a capital.
    { Success: false, error: 'artifact rejected' },
    // Revyl's own driver defaults a verdict-less body to success, but never one that names a failure.
    { error: 'worker crashed' },
  ]) {
    const client = clientResponding(() => jsonResponse(body));
    await assert.rejects(
      async () => await client.workerAction('run-1', 'tap', { x: 1, y: 2 }),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'provider-refused' &&
        error.details?.path === '/api/v1/execution/device-proxy/run-1/tap',
      JSON.stringify(body),
    );
  }
});

test('a device-proxy action with no verdict in its body reads as success', async () => {
  const client = clientResponding(() => jsonResponse({ action: 'tap' }));
  assert.deepEqual(await client.workerAction('run-1', 'tap', { x: 1, y: 2 }), { action: 'tap' });
});

test('a device-proxy action that reports itself uncertain stays uncertain', async () => {
  const client = clientResponding(() =>
    jsonResponse({ success: false, execution_uncertain: true, error: 'timeout' }),
  );
  await assert.rejects(
    async () => await client.workerAction('run-1', 'tap', { x: 1, y: 2 }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-unconfirmed',
  );
});

test('a JSON action body that is not JSON reports itself as unusable', async () => {
  const client = clientResponding(() => new Response('<html>gateway</html>', { status: 200 }));
  await assert.rejects(
    async () => await client.verifyCredentials(),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-response-invalid',
  );
});

test('reads a worker action whose body is text or bytes', async () => {
  const client = clientResponding(() => {
    return new Response('<AppiumAUT><XCUIElementTypeButton name="Go"/></AppiumAUT>', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    });
  });
  assert.match(await client.getWorkerHierarchy('run-1'), /XCUIElementTypeButton/);

  const png = clientResponding(
    () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
  );
  assert.deepEqual([...(await png.captureWorkerScreenshot('run-1'))], [0x89, 0x50, 0x4e, 0x47]);
});

test('a binary action whose failure is JSON still reports the typed error', async () => {
  const client = clientResponding(
    () =>
      new Response(JSON.stringify({ detail: 'session expired' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await assert.rejects(
    async () => await client.captureWorkerScreenshot('run-1'),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-session-gone',
  );
});

/** A client whose every answer comes from `reply`, recording each request it makes. */
function clientResponding(
  reply: (call: number) => Response | Promise<Response>,
  calls: Request[] = [],
): RevylClient {
  let index = 0;
  return createRevylClient({
    apiKey: 'test-key',
    backendUrl: 'http://127.0.0.1:9',
    clientVersion: '0.0.0-test',
    fetch: stubFetch((request) => {
      calls.push(request);
      return reply(index++);
    }),
  });
}

function stubFetch(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return await handler(request);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
