import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveHostedCloudAccess } from './cloud-access.ts';
import {
  readCloudSessionRequest,
  createCloudSession,
  deleteCloudSession,
  isDefinitiveCloudCreateRejection,
  parseMaxUsdMicros,
} from './cloud-session-api.ts';

const access = { cloudBaseUrl: 'https://cloud.example', accessToken: 'test-cloud-key' };
const request = {
  platform: 'android',
  vendor: 'provider-a',
  accepts: ['agent-device-daemon'],
  maxMinutes: 15,
} as const;
const attempt = { key: 'cloud-key', observeId: () => undefined };
const response = {
  id: '00000000-0000-4000-8000-000000000001',
  platform: 'android',
  vendor: 'provider-a',
  transport: 'agent-device-daemon',
  deadlineAt: '2026-11-19T15:00:00Z',
  viewerUrl: 'https://viewer.example/session?token=private',
  attach: {
    kind: 'agent-device-daemon',
    daemonBaseUrl: 'https://instance.example',
    daemonAuthToken: 'instance-token',
  },
} as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([
  { status: 200, body: { id: response.id, state: 'failed' }, released: true },
  { status: 200, body: { id: response.id, state: 'settled' }, released: true },
  { status: 200, body: { id: response.id, state: 'stopping' }, released: false },
  { status: 200, body: { id: 'other-session', state: 'settled' }, released: false },
  { status: 404, body: { id: response.id, state: 'settled' }, released: false },
])(
  'requires an authoritative terminal state after a release conflict (%j)',
  async ({ status, body, released }) => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) =>
      init.method === 'DELETE'
        ? Response.json({ error: 'still_stopping' }, { status: 409 })
        : Response.json(body, { status }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const release = deleteCloudSession(access, response.id);
    if (released) await expect(release).resolves.toBeUndefined();
    else await expect(release).rejects.toMatchObject({ details: { status: 409 } });
    expect(
      fetchMock.mock.calls.map(([url, { method, redirect }]) => [url.pathname, method, redirect]),
    ).toEqual([
      [`/v1/sessions/${response.id}`, 'DELETE', 'error'],
      [`/v1/sessions/${response.id}`, 'GET', 'error'],
    ]);
  },
);

test('POSTs the requested limits with the cloud key and delivers the scoped attachment', async () => {
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) =>
    Response.json(response, { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const result = await createCloudSession(access, request, attempt);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url.href).toBe('https://cloud.example/v1/sessions');
  expect(init.method).toBe('POST');
  expect(init.redirect).toBe('error');
  expect(init.headers).toMatchObject({
    authorization: 'Bearer test-cloud-key',
    'Idempotency-Key': expect.stringMatching(/^[!-~]{1,255}$/),
  });
  expect(JSON.parse(String(init.body))).toEqual({
    platform: 'android',
    vendor: 'provider-a',
    maxMinutes: 15,
    accepts: ['agent-device-daemon'],
  });
  expect(result.binding).toEqual({
    id: '00000000-0000-4000-8000-000000000001',
    baseUrl: 'https://cloud.example',
    vendor: 'provider-a',
    transport: 'agent-device-daemon',
    deadlineAt: '2026-11-19T15:00:00.000Z',
    viewerAvailable: true,
  });
  expect(result.attachment).toEqual(response.attach);
});

test('retries transport and allocation failures on a two-second interval with one request key', async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const scripted: Array<() => Response> = [
    () => {
      throw new TypeError('fetch failed');
    },
    () => {
      throw new DOMException('request timed out', 'TimeoutError');
    },
    () => new Response(null, { status: 503 }),
    () => Response.json({ error: 'allocation_in_progress', id: response.id }, { status: 409 }),
  ];
  // The progress status read is a GET; only creates take a scripted answer.
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === 'GET'
      ? Response.json({ error: 'not_found' }, { status: 404 })
      : (scripted.shift()?.() ?? Response.json(response, { status: 200 })),
  );
  vi.stubGlobal('fetch', fetchMock);
  const observeId = vi.fn();
  const connected = createCloudSession(access, request, { ...attempt, observeId });
  const creates = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;
  expect(creates()).toBe(1);
  for (const callCount of [2, 3, 4, 5]) {
    await vi.advanceTimersByTimeAsync(1999);
    expect(creates()).toBe(callCount - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(creates()).toBe(callCount);
  }
  await expect(connected).resolves.toMatchObject({ binding: { id: response.id } });
  expect(observeId.mock.calls).toEqual([[response.id], [response.id]]);
  const requests = fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body,
      key: new Headers(init?.headers).get('Idempotency-Key'),
    }));
  expect(requests[0]?.key).toMatch(/^[!-~]{1,255}$/);
  expect(requests.slice(0, 5)).toEqual(Array(5).fill(requests[0]));
});

test('stops allocation polling at the connect deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    Response.json({ error: 'allocation_in_progress', id: response.id }, { status: 409 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const observeId = vi.fn();
  const result = expect(
    createCloudSession(access, request, { ...attempt, observeId }),
  ).rejects.toMatchObject({
    details: { reason: 'cloud_session_connect_timeout' },
  });
  await vi.advanceTimersByTimeAsync(240_000);
  await result;
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(120);
  expect(observeId).toHaveBeenCalledWith(response.id);
});

test.each([
  [409, 'session_not_running', 'session_not_running'],
  [422, 'idempotency_key_reused', 'idempotency_key_reused'],
  [422, 'no_vendor_matches', 'no_vendor_matches'],
  [422, 'allocation_in_progress', undefined],
  [429, 'concurrency_limit', 'concurrency_limit'],
])('treats HTTP %i with %s as terminal', async (status, error, reason) => {
  const fetchMock = vi.fn(async () => Response.json({ error }, { status }));
  vi.stubGlobal('fetch', fetchMock);
  const observeId = vi.fn();
  await expect(
    createCloudSession(access, { ...request, needs: ['adb', 'viewer'] }, { ...attempt, observeId }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status, ...(reason ? { reason } : {}) },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(observeId).not.toHaveBeenCalled();
});

test('reports typed device and os rejections', async () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body, { status })),
    );
  const create = () => createCloudSession(access, request, { ...attempt, observeId: vi.fn() });
  respond(400, { error: 'invalid_request', field: 'os', detail: 'unknown version' });
  await expect(create()).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { status: 400, reason: 'invalid_request', field: 'os' },
  });
  respond(422, { error: 'device_unavailable', device: 'ipad', os: 'iOS 27' });
  await expect(create()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status: 422, reason: 'device_unavailable' },
  });
});

test('accepts a catalog vendor on Android', () => {
  expect(
    readCloudSessionRequest({
      help: false,
      json: false,
      version: false,
      platform: 'android',
      vendor: '  provider-a  ',
    }),
  ).toMatchObject({ platform: 'android', vendor: 'provider-a' });
});

test('refuses a non-loopback plaintext daemon attachment', async () => {
  const body = {
    ...response,
    attach: { ...response.attach, daemonBaseUrl: 'http://daemon.example/device' },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status: 201 })),
  );
  await expect(createCloudSession(access, request, attempt)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_session_invalid' },
  });
});

test('keeps optional plugin attachments outside the core transport', async () => {
  const observeId = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...response, transport: 'limrun' }, { status: 201 })),
  );
  await expect(
    createCloudSession(access, request, { ...attempt, observeId }),
  ).rejects.toMatchObject({
    details: { reason: 'cloud_transport_unsupported' },
  });
  expect(observeId).toHaveBeenCalledWith(response.id);
});

test('leaves an unusable created session to the connection owner to end', async () => {
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) =>
    Response.json({ ...response, attach: { kind: 'unknown' } }, { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(createCloudSession(access, request, attempt)).rejects.toMatchObject({
    details: { reason: 'cloud_session_invalid' },
  });
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST']);
});

test('accepts loopback plaintext for the cloud API and daemon', async () => {
  const localAccess = await resolveHostedCloudAccess({
    stateDir: mkdtempForTestSync('hosted-api-origin-'),
    env: {
      AGENT_DEVICE_CLOUD_BASE_URL: 'http://localhost:3000',
      AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: 'http://localhost:3000',
      AGENT_DEVICE_CLOUD_API_KEY: 'test-cloud-key',
    },
  });
  const attach = {
    ...response.attach,
    daemonBaseUrl: 'http://127.0.0.2:3001/instance',
  };
  const fetchMock = vi.fn(async (_url: URL) =>
    Response.json({ ...response, attach }, { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(createCloudSession(localAccess, request, attempt)).resolves.toMatchObject({
    attachment: attach,
  });
  expect(fetchMock.mock.calls[0]?.[0].origin).toBe('http://localhost:3000');
});

const baseFlags = { help: false, json: false, version: false, platform: 'android' } as const;
const cappedRequest = readCloudSessionRequest({ ...baseFlags, maxUsd: '0.50' });

test.each([
  ['0.5', '500000'],
  ['0.50', '500000'],
  ['1', '1000000'],
  ['0.000001', '1'],
  ['12.345678', '12345678'],
  ['1000', '1000000000'],
  ['1000.000000', '1000000000'],
])('parses --max-usd %s as %s micro-USD', (input, micros) => {
  expect(parseMaxUsdMicros(input)).toBe(micros);
  expect(readCloudSessionRequest({ ...baseFlags, maxUsd: input }).maxUsdMicros).toBe(micros);
});

test.each([
  '',
  '0',
  '0.0',
  '0.000000',
  '0.0000001',
  '1.2345678',
  '-1',
  '+1',
  '1e2',
  '1E-1',
  '.5',
  '1.',
  '00.5',
  '1,5',
  ' 1',
  '1 ',
  '0x10',
  'abc',
  '99999999999999999999',
])('rejects --max-usd %j', (input) => {
  expect(() => parseMaxUsdMicros(input)).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      details: { reason: 'cloud_invalid_max_usd' },
    }),
  );
});

test('leaves the cap out of an uncapped request', () => {
  expect(readCloudSessionRequest(baseFlags)).not.toHaveProperty('maxUsdMicros');
});

test('POSTs a capped request to the bounded route with the cap as a string', async () => {
  const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) =>
    Response.json({ ...response, reservedUsdMicros: '200000' }, { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await createCloudSession(access, cappedRequest, attempt);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url.href).toBe('https://cloud.example/v1/sessions/bounded');
  expect(JSON.parse(String(init.body))).toEqual({
    platform: 'android',
    accepts: ['agent-device-daemon'],
    maxUsdMicros: '500000',
  });
  expect(new Headers(init.headers).get('Idempotency-Key')).toBe('cloud-key');
});

test('keeps retrying a capped request on the bounded route only', async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(Response.json(response, { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  const created = createCloudSession(access, cappedRequest, attempt);
  await vi.advanceTimersByTimeAsync(4000);
  await expect(created).resolves.toMatchObject({ binding: { id: response.id } });
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
    Array(3).fill('https://cloud.example/v1/sessions/bounded'),
  );
});

test.each([404, 405])(
  'treats HTTP %i from the bounded route as budget_cap_unsupported without a second POST',
  async (status) => {
    const fetchMock = vi.fn(
      async (_url: URL, _init: RequestInit) => new Response(null, { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const observeId = vi.fn();
    const refused = await createCloudSession(access, cappedRequest, {
      ...attempt,
      observeId,
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { status, reason: 'budget_cap_unsupported' },
    });
    expect(isDefinitiveCloudCreateRejection(refused)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://cloud.example/v1/sessions/bounded');
    expect(observeId).not.toHaveBeenCalled();
  },
);

test('does not report an ordinary-route 404 as an unsupported cap', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'not_found' }, { status: 404 })),
  );
  const refused = await createCloudSession(access, request, attempt).catch(
    (error: unknown) => error,
  );
  expect(refused).not.toMatchObject({ details: { reason: 'budget_cap_unsupported' } });
});

async function refusal(status: number, body: unknown, req: object = request) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status })),
  );
  const rejection: unknown = await createCloudSession(access, req as typeof request, attempt).catch(
    (error: unknown) => error,
  );
  expect(isDefinitiveCloudCreateRejection(rejection)).toBe(true);
  return rejection as { code: string; message: string; details: Record<string, unknown> };
}

test('maps 402 insufficient_balance to bounded details and a billing link', async () => {
  const error = await refusal(402, {
    error: 'insufficient_balance',
    requiredUsdMicros: '200000',
    availableUsdMicros: '50000',
    shortfallUsdMicros: '150000',
    topUpUrl: 'https://cloud.example/app/billing#top-up',
    extra: 'dropped',
  });
  expect(error.code).toBe('INVALID_ARGS');
  expect(error.details).toEqual({
    status: 402,
    reason: 'insufficient_balance',
    hint: 'Top up the balance (needs $0.15 more).\nTop up at https://cloud.example/app/billing#top-up',
    requiredUsdMicros: '200000',
    availableUsdMicros: '50000',
    shortfallUsdMicros: '150000',
    topUpUrl: 'https://cloud.example/app/billing#top-up',
  });
  expect(error.message).toContain('needs at least $0.20');
  expect(error.message).toContain('balance is $0.05');
  expect(error.message).toContain('short by $0.15');
});

test('omits the billing link and shows a negative balance when top-ups are off', async () => {
  const error = await refusal(402, {
    error: 'insufficient_balance',
    requiredUsdMicros: '200000',
    availableUsdMicros: '-30000',
    shortfallUsdMicros: '230000',
  });
  expect(error.details).not.toHaveProperty('topUpUrl');
  expect(error.details.hint).toBe('Top up the balance (needs $0.23 more).');
  expect(error.message).toContain('balance is -$0.03');
  expect(error.message).not.toContain('http');
});

test.each([
  ['another origin', 'https://billing.example/app/billing#top-up'],
  ['a query on the billing page', 'https://cloud.example/app/billing?key=secret'],
  ['an arbitrary same-origin path', 'https://cloud.example/private-fixture'],
  ['javascript scheme', 'javascript:alert(1)'],
  ['plain http to a remote host', 'http://billing.example/top-up'],
  ['credentials in the URL', 'https://user:pass@billing.example/top-up'],
  ['an embedded newline', 'https://billing.example/top-up\nrm -rf'],
  ['an escape sequence', 'https://billing.example/\u001b[31mtop-up'],
  ['a space', 'https://billing.example/top up'],
  ['a non-ASCII host', 'https://billing.exämple/top-up'],
  ['an oversized URL', `https://billing.example/${'a'.repeat(3000)}`],
  ['a non-string value', 42],
])('drops a topUpUrl with %s before display', async (_name, topUpUrl) => {
  const error = await refusal(402, {
    error: 'insufficient_balance',
    requiredUsdMicros: '200000',
    availableUsdMicros: '50000',
    shortfallUsdMicros: '150000',
    topUpUrl,
  });
  expect(error.details).not.toHaveProperty('topUpUrl');
  expect(error.details.hint).toBe('Top up the balance (needs $0.15 more).');
  for (const fragment of ['javascript', 'rm -rf', '\u001b', 'user:pass', 'top up', 'http']) {
    expect(error.message).not.toContain(fragment);
  }
});

test('drops malformed amounts and accepts a legacy bare 402', async () => {
  const hostile = await refusal(402, {
    error: 'insufficient_balance',
    requiredUsdMicros: '1e6',
    availableUsdMicros: '\u001b[31m5',
    shortfallUsdMicros: 150000,
  });
  expect(hostile.details).toEqual({
    status: 402,
    reason: 'insufficient_balance',
    hint: 'Top up the balance.',
  });
  expect(hostile.message).not.toContain('\u001b');
  const legacy = await refusal(402, {}, request);
  expect(legacy.details).toEqual({
    status: 402,
    reason: 'insufficient_balance',
    hint: 'Top up the balance.',
  });
  expect(legacy.message).toContain('balance is too low');
});

test('maps 422 budget_exceeded to the cap and the minimum', async () => {
  const error = await refusal(422, {
    error: 'budget_exceeded',
    maxUsdMicros: '100000',
    minimumUsdMicros: '200000',
  });
  expect(error.code).toBe('INVALID_ARGS');
  expect(error.details).toEqual({
    status: 422,
    reason: 'budget_exceeded',
    hint: 'Raise --max-usd to at least $0.20 or choose a cheaper device.',
    maxUsdMicros: '100000',
    minimumUsdMicros: '200000',
  });
  expect(error.message).toContain('at least $0.20');
  expect(error.message).toContain('cap of $0.10');
});

test.each([
  [402, 'key_budget_exceeded'],
  [422, 'account_cap_exceeded'],
])('maps %i %s to INVALID_ARGS with the limit hint', async (status, reason) => {
  const error = await refusal(status as 402 | 422, { error: reason });
  expect(error.code).toBe('INVALID_ARGS');
  expect(error.details).toEqual({
    status,
    reason,
    hint: 'Raise the limit in the dashboard or wait for the next month.',
  });
});

test('keeps other 422 reasons on their own mapping', async () => {
  const error = await refusal(422, { error: 'no_vendor_matches' });
  expect(error.details).toMatchObject({ reason: 'no_vendor_matches' });
});

test('keeps self-hosted daemon credentials off the default cloud origin', async () => {
  const stateDir = mkdtempForTestSync('hosted-api-credential-');
  await expect(
    resolveHostedCloudAccess({
      stateDir,
      env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'local-daemon-token' },
    }),
  ).rejects.toMatchObject({ details: { reason: 'cloud_api_key_required' } });
  const key = `adc_live_${'a'.repeat(43)}`;
  await expect(
    resolveHostedCloudAccess({
      stateDir,
      env: { AGENT_DEVICE_CLOUD_API_KEY: key },
    }),
  ).resolves.toMatchObject({ accessToken: key });
});

const encodedBroker = Array.from(
  access.accessToken,
  (char) => '%' + char.charCodeAt(0).toString(16),
).join('');

test.each([
  { daemonBaseUrl: `https://instance.example/${encodedBroker}` },
  { daemonAuthToken: `echo-${access.accessToken}-suffix` },
])('refuses a broker credential echoed in a daemon attachment', async (overrides) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...response,
        attach: { ...response.attach, ...overrides },
      }),
    ),
  );
  await expect(createCloudSession(access, request, attempt)).rejects.toMatchObject({
    details: { reason: 'cloud_session_invalid' },
  });
});

test('omits a scoped viewer link with an encoded attachment credential', async () => {
  const token = response.attach.daemonAuthToken;
  const encodedToken = Array.from(token, (char) => '%' + char.charCodeAt(0).toString(16)).join('');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...response,
        viewerUrl: `https://viewer.example/session?mode=live#token=${encodedToken}`,
      }),
    ),
  );
  await expect(createCloudSession(access, request, attempt)).resolves.toMatchObject({
    binding: { id: response.id, viewerAvailable: false },
    viewerUrl: undefined,
  });
});

test('uses the normalized attachment bearer for both viewer filtering and storage', async () => {
  const token = 'fixture-scoped-bearer';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...response,
        transport: 'limrun',
        attach: {
          platform: 'android',
          apiUrl: 'https://instance.example',
          token: ` ${token} `,
          adbWebSocketUrl: 'wss://instance.example/adb',
        },
        viewerUrl: `https://viewer.example/watch#token=${token}`,
      }),
    ),
  );
  await expect(
    createCloudSession(access, { ...request, accepts: ['limrun'] }, attempt),
  ).resolves.toMatchObject({
    attachment: { token },
    binding: { viewerAvailable: false },
    viewerUrl: undefined,
  });
});

test.each([
  'Thu, 19 Nov 2026 15:00:00 GMT (instance-token)',
  'Thu, 19 Nov 2026 15:00:00 GMT (test-cloud-key)',
  '2026-02-30T15:00:00Z',
])('refuses invalid public deadlines (%s)', async (deadlineAt) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...response, deadlineAt })),
  );
  await expect(createCloudSession(access, request, attempt)).rejects.toMatchObject({
    details: { reason: 'cloud_session_invalid' },
  });
});

test.each([access.accessToken, response.attach.daemonAuthToken])(
  'refuses a canonical deadline that also serves as a bearer',
  async (token) => {
    const deadlineAt = '2026-11-19T15:00:00.000Z';
    const brokerEcho = token === access.accessToken;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...response,
          deadlineAt,
          attach: { ...response.attach, daemonAuthToken: brokerEcho ? token : deadlineAt },
        }),
      ),
    );
    await expect(
      createCloudSession(
        { ...access, accessToken: brokerEcho ? deadlineAt : access.accessToken },
        request,
        attempt,
      ),
    ).rejects.toMatchObject({ details: { reason: 'cloud_session_invalid' } });
  },
);

test.each([
  { token: access.accessToken },
  { token: `echo-${access.accessToken}-suffix` },
  { apiUrl: `https://instance.example/${encodedBroker}` },
  { apiUrl: `https://instance.example/${access.accessToken}` },
  { adbWebSocketUrl: `wss://instance.example/?query=${encodedBroker}` },
  { adbWebSocketUrl: 'wss://adb.example' },
  { adbWebSocketUrl: 'wss://instance.example:8443' },
  { apiUrl: 'http://instance.example' },
  { adbWebSocketUrl: 'ws://adb.example' },
  { platform: 'ios' },
])('refuses an invalid scoped plugin attachment %o', async (overrides) => {
  const observeId = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        ...response,
        vendor: 'limrun',
        transport: 'limrun',
        attach: {
          kind: 'limrun',
          platform: 'android',
          apiUrl: 'https://instance.example',
          token: 'test-scoped-token',
          adbWebSocketUrl: 'wss://instance.example',
          ...overrides,
        },
      }),
    ),
  );
  await expect(
    createCloudSession(
      access,
      { ...request, vendor: 'limrun', accepts: ['agent-device-daemon', 'limrun'] },
      { ...attempt, observeId },
    ),
  ).rejects.toMatchObject({ details: { reason: 'cloud_session_invalid' } });
  expect(observeId).toHaveBeenCalledWith(response.id);
});
