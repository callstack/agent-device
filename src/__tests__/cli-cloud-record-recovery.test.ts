import { afterEach, expect, test, vi } from 'vitest';
import { writeCliSession } from '../cli/auth-session.ts';
import { readCloudConnection } from '../cli/connection/cloud-connection-record.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  cloudEnv,
  connectArgs,
  locationOf,
  postKey,
  stubCloudApi,
  timeOutNextCreate,
} from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a timed-out allocation survives a 429 retry and disconnect under another credential', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  timeOutNextCreate(fetchMock);
  const timedOut = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  const generation = readCloudConnection(location)?.generation;
  expect(generation).toBe(postKey(fetchMock.mock.calls[0]![1]));
  expect(JSON.stringify(readCloudConnection(location))).not.toContain(
    env.AGENT_DEVICE_CLOUD_API_KEY,
  );
  vi.restoreAllMocks();

  const other = { ...env, AGENT_DEVICE_CLOUD_API_KEY: 'other-account-api-key' };
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'concurrency_limit' }, { status: 429 }));
  const refused = await runCliCapture(connectArgs, { env: other });
  expect(JSON.parse(refused.stdout).error.details).toMatchObject({
    status: 429,
    reason: 'concurrency_limit',
  });
  expect(postKey(fetchMock.mock.calls[1]![1])).toBe(generation);
  expect(readCloudConnection(location)).toMatchObject({ phase: 'pending', generation });

  const refusedDisconnect = await runCliCapture(['disconnect', '--json'], { env: other });
  expect(JSON.parse(refusedDisconnect.stdout).error.details.reason).toBe(
    'cloud_connection_credential_mismatch',
  );
  expect(readCloudConnection(location)?.generation).toBe(generation);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  fetchMock.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
  const disconnected = await runCliCapture(['disconnect', '--json'], { env });
  expect(disconnected.code, disconnected.stdout).toBeNull();
  expect(readCloudConnection(location)).toBeNull();
  expect(fetchMock.mock.calls[2]?.[0].searchParams.get('idempotencyKey')).toBe(generation);
});

test('an ingress 404 cannot resolve a refused allocation under the original credential', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  timeOutNextCreate(fetchMock);
  const timedOut = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  const pending = readCloudConnection(location);
  vi.restoreAllMocks();

  fetchMock
    .mockResolvedValueOnce(Response.json({ error: 'no_vendor_matches' }, { status: 422 }))
    .mockResolvedValueOnce(new Response('<h1>Not Found</h1>', { status: 404 }));
  const refused = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(refused.stdout).error.details.reason).toBe('no_vendor_matches');
  expect(readCloudConnection(location)).toEqual(pending);
  expect(fetchMock.mock.calls[2]?.[0].searchParams.get('idempotencyKey')).toBe(pending?.generation);
});

test.each([
  { accountId: 'original-account', clears: true },
  { accountId: undefined, clears: false },
])(
  'a login with account identity $accountId recovers across token rotation ($clears)',
  async ({ accountId, clears }) => {
    const env = cloudEnv();
    const location = locationOf(env);
    const loginEnv = { ...env, AGENT_DEVICE_CLOUD_API_KEY: undefined };
    writeCliSession({
      stateDir: location.stateDir,
      session: {
        version: 2,
        id: 'fixture-login',
        accountId,
        cloudBaseUrl: env.AGENT_DEVICE_CLOUD_BASE_URL,
        refreshCredential: 'login-refresh-credential',
        createdAt: new Date().toISOString(),
      },
    });
    const fetchMock = stubCloudApi();
    fetchMock.mockResolvedValueOnce(Response.json({ accessToken: 'first-access-token' }));
    timeOutNextCreate(fetchMock);
    const timedOut = await runCliCapture(connectArgs, { env: loginEnv });
    expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
    const pending = readCloudConnection(location);
    expect(pending?.generation).toBe(postKey(fetchMock.mock.calls[1]![1]));
    expect(JSON.stringify(pending)).not.toContain('first-access-token');
    vi.restoreAllMocks();

    fetchMock.mockResolvedValueOnce(Response.json({ accessToken: 'rotated-access-token' }));
    if (clears) {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
    }
    const result = await runCliCapture(['disconnect', '--json'], { env: loginEnv });
    if (clears) {
      expect(result.code, result.stdout).toBeNull();
      expect(readCloudConnection(location)).toBeNull();
      const [url, init] = fetchMock.mock.calls[3]!;
      expect(url.searchParams.get('idempotencyKey')).toBe(pending?.generation);
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer rotated-access-token');
    } else {
      expect(JSON.parse(result.stdout).error.details.reason).toBe(
        'cloud_connection_credential_mismatch',
      );
      expect(readCloudConnection(location)?.generation).toBe(pending?.generation);
      expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'POST']);
    }
  },
);
