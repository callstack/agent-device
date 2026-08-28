import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { runCmdSync } from '@agent-device/host-kit/command';

const mocks = vi.hoisted(() => ({
  approvePublicNetworkUrl: vi.fn(),
  requestApprovedUrl: vi.fn(),
}));

vi.mock('@agent-device/provision-kit/install-source-network', () => ({
  approvePublicNetworkUrl: mocks.approvePublicNetworkUrl,
}));
vi.mock('@agent-device/provision-kit/install-source-network-transport', () => ({
  requestApprovedUrl: mocks.requestApprovedUrl,
}));

import {
  executeRunScriptHttpRequest,
  MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
  parseRunScriptHttpRequest,
} from '../run-script-http-child.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('keeps unrestricted requests on the local fetch path', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    status: 201,
    text: async () => 'created',
    headers: new Headers([['x-result', 'ok']]),
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await executeRunScriptHttpRequest({
    method: 'POST',
    url: 'http://127.0.0.1:8080/local',
    headers: { authorization: 'secret' },
    body: '{}',
    networkAccess: 'unrestricted',
  });

  assert.deepEqual(result, { status: 201, body: 'created', headers: { 'x-result': 'ok' } });
  assert.deepEqual(fetchMock.mock.calls[0], [
    'http://127.0.0.1:8080/local',
    { method: 'POST', headers: { authorization: 'secret' }, body: '{}' },
  ]);
});

test('fails unrestricted requests when the local fetch implementation is unavailable', async () => {
  vi.stubGlobal('fetch', undefined);

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:8080/local',
      headers: {},
      networkAccess: 'unrestricted',
    }),
    /global fetch is required/,
  );
});

test('rejects malformed public URLs before network approval', async () => {
  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'not a URL',
      headers: {},
      networkAccess: 'public-only',
    }),
    /Invalid Maestro runScript HTTP URL/,
  );
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls.length, 0);
});

test('revalidates every Maestro HTTP redirect before dispatching it', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
  mocks.approvePublicNetworkUrl.mockRejectedValueOnce(
    new AppError(
      'INVALID_ARGS',
      'Maestro runScript URL host is not allowed because it resolves to a non-public address: 127.0.0.1',
    ),
  );
  mocks.requestApprovedUrl.mockResolvedValue(response(302, { location: 'https://127.0.0.1/next' }));

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'POST',
      url: 'https://example.test/start',
      headers: { authorization: 'secret', accept: 'application/json' },
      body: '{}',
      networkAccess: 'public-only',
    }),
    /non-public address/,
  );
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 1);
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls.length, 2);
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls[1]?.[0].href, 'https://127.0.0.1/next');
});

test('follows an approved same-origin Maestro HTTP redirect with fetch semantics', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  mocks.requestApprovedUrl
    .mockResolvedValueOnce(response(302, { location: 'https://example.test/next' }))
    .mockResolvedValueOnce(response(200, {}, 'ok'));

  const result = await executeRunScriptHttpRequest({
    method: 'POST',
    url: 'https://example.test/start',
    headers: { authorization: 'secret' },
    body: '{}',
    networkAccess: 'public-only',
  });

  assert.deepEqual(result, { status: 200, body: 'ok', headers: {} });
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 2);
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].method, 'GET');
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].body, undefined);
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].headers.authorization, 'secret');
});

test('classifies redirects before reading their response bodies', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  let resumed = false;
  const redirectBody = {
    resume: () => {
      resumed = true;
    },
  } as unknown as NodeJS.ReadableStream;
  mocks.requestApprovedUrl
    .mockResolvedValueOnce(response(302, { location: 'https://example.test/next' }, redirectBody))
    .mockResolvedValueOnce(response(200, {}, 'ok'));

  const result = await executeRunScriptHttpRequest({
    method: 'GET',
    url: 'https://example.test/start',
    headers: {},
    networkAccess: 'public-only',
  });

  assert.equal(result.body, 'ok');
  assert.equal(resumed, true);
});

test('rejects redirects without a location and closes the response', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  const redirect = response(302);
  mocks.requestApprovedUrl.mockResolvedValue(redirect);

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'https://example.test/start',
      headers: {},
      networkAccess: 'public-only',
    }),
    /redirect limit was exceeded/,
  );
  assert.equal(redirect.close.mock.calls.length, 1);
});

test('rejects HTTPS redirects that downgrade to HTTP', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  const redirect = response(302, { location: 'http://example.test/next' });
  mocks.requestApprovedUrl.mockResolvedValue(redirect);

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'https://example.test/start',
      headers: {},
      networkAccess: 'public-only',
    }),
    /redirect downgraded HTTPS/,
  );
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 1);
});

test('limits cross-origin redirect headers and preserves POST bodies for 307', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  mocks.requestApprovedUrl
    .mockResolvedValueOnce(response(307, { location: ['https://other.test/next'] }))
    .mockResolvedValueOnce(
      response(200, { 'set-cookie': ['a=1', 'b=2'], 'x-empty': undefined }, 'ok'),
    );

  const result = await executeRunScriptHttpRequest({
    method: 'POST',
    url: 'https://example.test/start',
    headers: {
      authorization: 'secret',
      accept: 'application/json',
      'user-agent': 'agent-device-test',
    },
    body: '{}',
    networkAccess: 'public-only',
  });

  assert.deepEqual(result, {
    status: 200,
    body: 'ok',
    headers: { 'set-cookie': 'a=1, b=2', 'x-empty': '' },
  });
  const redirectedRequest = mocks.requestApprovedUrl.mock.calls[1]?.[0];
  assert.equal(redirectedRequest?.url.href, 'https://other.test/next');
  assert.deepEqual(redirectedRequest?.headers, {
    accept: 'application/json',
    'user-agent': 'agent-device-test',
  });
  assert.equal(redirectedRequest?.approvedAddress, '93.184.216.34');
  assert.equal(redirectedRequest?.family, 4);
  assert.equal(redirectedRequest?.method, 'POST');
  assert.equal(redirectedRequest?.body, '{}');
});

test('stops after the redirect limit', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  mocks.requestApprovedUrl.mockImplementation(async () =>
    response(302, { location: 'https://example.test/next' }),
  );

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'https://example.test/start',
      headers: {},
      networkAccess: 'public-only',
    }),
    /redirect limit was exceeded/,
  );
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls.length, 6);
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 6);
});

test('caps final public response bodies while consuming them incrementally', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  let yieldedChunks = 0;
  const body = Readable.from(
    (function* () {
      yieldedChunks += 1;
      yield Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES / 2, 0x61);
      yieldedChunks += 1;
      yield Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES / 2, 0x62);
      yieldedChunks += 1;
      yield Buffer.from('overflow');
    })(),
  );
  mocks.requestApprovedUrl.mockResolvedValue(response(200, {}, body));

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'https://example.test/large',
      headers: {},
      networkAccess: 'public-only',
    }),
    new RegExp(`response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`),
  );
  assert.equal(yieldedChunks, 3);
});

function response(
  statusCode: number,
  headers: Record<string, string | string[] | undefined> = {},
  body: string | NodeJS.ReadableStream = '',
): {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    statusCode,
    headers,
    body: typeof body === 'string' ? Readable.from([body]) : body,
    close: vi.fn(async () => {}),
  };
}

const childModulePath = fileURLToPath(new URL('../run-script-http-child.ts', import.meta.url));

test('reports malformed JSON received by the HTTP child', () => {
  const result = runHttpChildRaw('{');

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /SyntaxError|Unexpected end/);
});

for (const [name, input, errorMessage] of [
  ['null input', null, 'invalid Maestro runScript HTTP input'],
  ['array input', [], 'invalid Maestro runScript HTTP input'],
  [
    'unsupported method',
    { method: 'PUT', url: 'https://example.test', headers: {}, networkAccess: 'public-only' },
    'invalid Maestro runScript HTTP method',
  ],
  [
    'non-string URL',
    { method: 'GET', url: 42, headers: {}, networkAccess: 'public-only' },
    'invalid Maestro runScript HTTP input',
  ],
  [
    'missing headers',
    { method: 'GET', url: 'https://example.test', networkAccess: 'public-only' },
    'invalid Maestro runScript HTTP headers',
  ],
  [
    'array headers',
    { method: 'GET', url: 'https://example.test', headers: [], networkAccess: 'public-only' },
    'invalid Maestro runScript HTTP headers',
  ],
  [
    'non-string header value',
    {
      method: 'GET',
      url: 'https://example.test',
      headers: { authorization: 42 },
      networkAccess: 'public-only',
    },
    'invalid Maestro runScript HTTP headers',
  ],
  [
    'non-string body',
    {
      method: 'GET',
      url: 'https://example.test',
      headers: {},
      body: 42,
      networkAccess: 'public-only',
    },
    'invalid Maestro runScript HTTP body',
  ],
  [
    'unsupported network policy',
    { method: 'GET', url: 'https://example.test', headers: {} },
    'invalid Maestro runScript HTTP network policy',
  ],
] as const) {
  test(`rejects ${name} from the HTTP child`, () => {
    assert.throws(() => parseRunScriptHttpRequest(input), new RegExp(errorMessage));
  });
}

function runHttpChildRaw(stdin: string) {
  return runCmdSync(process.execPath, ['--experimental-strip-types', childModulePath], {
    stdin,
    allowFailure: true,
  });
}
