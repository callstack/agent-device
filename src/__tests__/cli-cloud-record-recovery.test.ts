import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { writeCliSession } from '../cli/auth-session.ts';
import {
  cloudConnectionDir,
  prepareCloudConnection,
  readCloudConnection,
  writeCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import { readCloudSessionRequest } from '../cli/connection/cloud-session-api.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  cloudEnv,
  connectArgs,
  hostedDevice,
  locationOf,
  postKey,
  stubCloudApi,
  timeOutNextCreate,
} from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function timeOutAllocation(
  env: Record<string, string | undefined>,
  fetchMock: ReturnType<typeof stubCloudApi>,
) {
  timeOutNextCreate(fetchMock);
  const result = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(result.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  vi.restoreAllMocks();
}

test('refuses a retry from another account before it requests an allocation', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  await timeOutAllocation(env, fetchMock);
  const pending = readCloudConnection(location);
  expect(pending?.generation).toBe(postKey(fetchMock.mock.calls[0]![1]));
  expect(JSON.stringify(pending)).not.toContain(env.AGENT_DEVICE_CLOUD_API_KEY);

  const other = { ...env, AGENT_DEVICE_CLOUD_API_KEY: 'other-account-api-key' };
  const refused = await runCliCapture(connectArgs, { env: other });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    details: { reason: 'cloud_connection_credential_mismatch' },
    hint: expect.stringContaining('disconnect --forget'),
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readCloudConnection(location)).toEqual(pending);
});

test('a binding mismatch keeps a known session ID and sends no broker DELETE', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();

  const other = { ...env, AGENT_DEVICE_CLOUD_API_KEY: 'other-account-api-key' };
  const refused = await runCliCapture(['disconnect', '--json'], { env: other });
  expect(JSON.parse(refused.stdout).error.details.reason).toBe(
    'cloud_connection_credential_mismatch',
  );
  expect(readCloudConnection(location)?.id).toBe(hostedDevice.id);
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST']);

  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
  expect(readCloudConnection(location)).toBeNull();
});

test('a 429 retry under the original credential keeps the pending generation', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  await timeOutAllocation(env, fetchMock);
  const pending = readCloudConnection(location);

  fetchMock.mockResolvedValueOnce(Response.json({ error: 'concurrency_limit' }, { status: 429 }));
  const refused = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(refused.stdout).error.details).toMatchObject({
    status: 429,
    reason: 'concurrency_limit',
  });
  expect(fetchMock.mock.calls.map(([, init]) => postKey(init))).toEqual([
    pending?.generation,
    pending?.generation,
  ]);
  expect(readCloudConnection(location)).toEqual(pending);
});

test.each([
  ['broker-shaped', () => Response.json({ error: 'not_found' }, { status: 404 })],
  ['ingress', () => new Response('<h1>Not Found</h1>', { status: 404 })],
] as const)('a %s lookup 404 cannot resolve a refused allocation', async (_kind, missing) => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  await timeOutAllocation(env, fetchMock);
  const pending = readCloudConnection(location);

  fetchMock
    .mockResolvedValueOnce(Response.json({ error: 'no_vendor_matches' }, { status: 422 }))
    .mockResolvedValueOnce(missing())
    .mockResolvedValueOnce(missing());
  const refused = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(refused.stdout).error.details.reason).toBe('no_vendor_matches');
  expect(readCloudConnection(location)).toEqual(pending);

  const disconnect = await runCliCapture(['disconnect', '--json'], { env });
  expect(JSON.parse(disconnect.stdout).error.details.reason).toBe(
    'cloud_connection_allocation_unconfirmed',
  );
  expect(readCloudConnection(location)?.generation).toBe(pending?.generation);
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual([
    'POST',
    'POST',
    'GET',
    'GET',
  ]);
  for (const [url] of fetchMock.mock.calls.slice(2)) {
    expect(url.searchParams.get('idempotencyKey')).toBe(pending?.generation);
  }
});

function writeLegacyPending(env: ReturnType<typeof cloudEnv>, id?: string) {
  const location = locationOf(env);
  const record = prepareCloudConnection(
    location.session,
    readCloudSessionRequest({ platform: 'ios', json: false, help: false, version: false }),
    env.AGENT_DEVICE_CLOUD_BASE_URL,
    null,
  );
  writeCloudConnection(location, { ...record, id });
  return record;
}

test.each([
  { kind: 'malformed', reason: 'cloud_connection_record_malformed' },
  { kind: 'unreadable', reason: 'cloud_connection_record_unreadable' },
])('forget clears the $kind record without opening it', async ({ kind, reason }) => {
  const env = cloudEnv();
  const location = locationOf(env);
  writeLegacyPending(env);
  const file = path.join(cloudConnectionDir(location), 'record.json');
  if (kind === 'malformed') fs.writeFileSync(file, '{');
  const openSync = fs.openSync;
  const open = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (kind === 'unreadable' && args[0] === file) {
      throw Object.assign(new Error('fixture cannot open the record'), { code: 'EACCES' });
    }
    return openSync(...args);
  });
  const fetchMock = stubCloudApi();

  const refused = await runCliCapture(['disconnect', '--json'], { env });
  expect(JSON.parse(refused.stdout).error.details.reason).toBe(reason);
  open.mockClear();
  const forgotten = await runCliCapture(
    ['disconnect', '--forget', '--session', location.session, '--json'],
    { env },
  );
  expect(forgotten.code, forgotten.stdout).toBeNull();
  expect(JSON.parse(forgotten.stdout).data).toMatchObject({ forgotten: true, released: false });
  expect(open.mock.calls.some(([fileToOpen]) => fileToOpen === file)).toBe(false);
  expect(fs.existsSync(file)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.skipIf(process.platform === 'win32')('forget refuses an unsafe record file', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  writeLegacyPending(env);
  const file = path.join(cloudConnectionDir(location), 'record.json');
  fs.chmodSync(file, 0o644);
  const fetchMock = stubCloudApi();
  const refused = await runCliCapture(
    ['disconnect', '--forget', '--session', location.session, '--json'],
    { env },
  );
  expect(JSON.parse(refused.stdout).error.details.reason).toBe('cloud_credential_store_unsafe');
  expect(fs.existsSync(file)).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an unbound legacy allocation can resume after a positive lookup of its key', async () => {
  const env = cloudEnv();
  const record = writeLegacyPending(env);
  const fetchMock = stubCloudApi();
  const result = await runCliCapture(connectArgs, { env });

  expect(result.code, result.stdout).toBeNull();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST']);
  expect(fetchMock.mock.calls[0]![0].searchParams.get('idempotencyKey')).toBe(record.generation);
  expect(postKey(fetchMock.mock.calls[1]![1])).toBe(record.generation);
  expect(readCloudConnection(locationOf(env))).toMatchObject({
    phase: 'committed',
    generation: record.generation,
    id: hostedDevice.id,
    accountBinding: expect.stringMatching(/^api-key:/),
  });
});

test.each([undefined, hostedDevice.id])(
  'an unbound legacy allocation with ID %s needs proof or an explicit local forget',
  async (id) => {
    const env = cloudEnv();
    const location = locationOf(env);
    const record = writeLegacyPending(env, id);
    const fetchMock = stubCloudApi();
    for (const args of [connectArgs, ['disconnect', '--json']]) {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
      const blocked = await runCliCapture(args, { env });
      expect(JSON.parse(blocked.stdout).error).toMatchObject({
        details: { reason: 'cloud_connection_allocation_unconfirmed' },
        hint: expect.stringContaining('disconnect --forget'),
      });
      expect(readCloudConnection(location)).toMatchObject({ generation: record.generation });
      expect(readCloudConnection(location)?.accountBinding).toBeUndefined();
      expect(readCloudConnection(location)?.id).toBe(id);
    }

    const forgotten = await runCliCapture(
      ['disconnect', '--forget', '--session', location.session, '--json'],
      { env },
    );
    expect(JSON.parse(forgotten.stdout).data).toMatchObject({ forgotten: true, released: false });
    expect(forgotten.stderr).toContain(
      'A rental may still exist on the hosted broker until its deadline.',
    );
    expect(readCloudConnection(location)).toBeNull();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'GET']);
  },
);

test.each([
  { accountId: 'original-account', label: 'bound' },
  { accountId: undefined, label: 'unbound' },
])('disconnect verifies a $label login across access token rotation', async ({ accountId }) => {
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
  await timeOutAllocation(loginEnv, fetchMock);
  const pending = readCloudConnection(location);
  expect(pending?.generation).toBe(postKey(fetchMock.mock.calls[1]![1]));
  expect(pending?.accountBinding).toBe(accountId ? `account:${accountId}` : undefined);
  expect(JSON.stringify(pending)).not.toContain('first-access-token');

  fetchMock.mockResolvedValueOnce(Response.json({ accessToken: 'rotated-access-token' }));
  const result = await runCliCapture(['disconnect', '--json'], { env: loginEnv });
  expect(result.code, result.stdout).toBeNull();
  expect(readCloudConnection(location)).toBeNull();
  const [url, init] = fetchMock.mock.calls[3]!;
  expect(url.searchParams.get('idempotencyKey')).toBe(pending?.generation);
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer rotated-access-token');
  expect(fetchMock.mock.calls.map(([, call]) => call.method)).toEqual([
    'POST',
    'POST',
    'POST',
    'GET',
    'DELETE',
  ]);
});
