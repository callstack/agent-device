import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { readCloudConnection } from '../cli/connection/cloud-connection-record.ts';
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

const cappedArgs = [...connectArgs, '--max-usd', '0.50'];

test('connects with --max-usd through the bounded route and resumes with the same cap and key', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  timeOutNextCreate(fetchMock);
  const timedOut = await runCliCapture(cappedArgs, { env });
  expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  const changedCap = await runCliCapture([...connectArgs, '--max-usd', '0.60', '--force'], { env });
  expect(JSON.parse(changedCap.stdout).error.details.reason).toBe('cloud_connect_pending_conflict');
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json(hostedDevice, { status: 200 }));
  const resumed = await runCliCapture(cappedArgs, { env });
  expect(resumed.code, resumed.stderr || resumed.stdout).toBeNull();
  const posts = fetchMock.mock.calls.filter(([, init]) => init.method === 'POST');
  expect(posts.map(([url]) => url.pathname)).toEqual(Array(2).fill('/v1/sessions/bounded'));
  const firstKey = postKey(posts[0]![1]);
  expect(firstKey).toMatch(/\S/);
  expect(posts.map(([, init]) => postKey(init))).toEqual([firstKey, firstKey]);
  expect(JSON.parse(String(posts[1]![1].body))).toMatchObject({ maxUsdMicros: '500000' });
  expect(readCloudConnection(location)).toMatchObject({ phase: 'committed', id: hostedDevice.id });
});

test('the hosted auth gate accepts a padded cloud provider with a spend cap', async () => {
  const fetchMock = stubCloudApi();
  const connected = await runCliCapture(
    ['connect', ' cloud ', '--platform', 'ios', '--max-usd', '0.50', '--json'],
    { env: cloudEnv() },
  );
  expect(connected.code, connected.stdout).toBeNull();
  expect(fetchMock.mock.calls[0]?.[0].pathname).toBe('/v1/sessions/bounded');
});

test.each([404, 405])(
  'clears the rejected allocation on HTTP %i from the bounded endpoint',
  async (status) => {
    const env = cloudEnv();
    const fetchMock = stubCloudApi();
    fetchMock.mockResolvedValueOnce(new Response(null, { status }));
    const refused = await runCliCapture(cappedArgs, { env });
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { status, reason: 'budget_cap_unsupported' },
    });
    expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
      ['POST', '/v1/sessions/bounded'],
    ]);
    expect(readCloudConnection(locationOf(env))).toBeNull();
    expect(readRemoteConnectionState(locationOf(env))).toBeNull();
  },
);

test('rejects an archive URL whose serialized form exceeds the limit before saving intent', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  const appUrl = `https://archives.example/${'<'.repeat(700)}.zip`;
  const refused = await runCliCapture([...connectArgs, '--app-url', appUrl], { env });

  expect(JSON.parse(refused.stdout)).toMatchObject({
    success: false,
    error: { details: { reason: 'cloud_invalid_app_url' } },
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readCloudConnection(locationOf(env))).toBeNull();
});

test.each([
  { status: 404, body: null },
  { status: 405, body: null },
  { status: 400, body: { error: 'app_source_unsupported' } },
  { status: 502, body: { error: 'app_preload_failed' } },
])('preload refusal $status clears the rejected allocation', async ({ status, body }) => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(
    body ? Response.json(body, { status }) : new Response(null, { status }),
  );
  const refused = await runCliCapture(
    [...cappedArgs, '--app-url', 'https://artifacts.example/app.zip'],
    { env },
  );
  expect(JSON.parse(refused.stdout).error.details.reason).toBe(
    body?.error ?? 'app_source_unsupported',
  );
  expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
    ['POST', '/v1/sessions/preloaded'],
  ]);
  expect(readCloudConnection(locationOf(env))).toBeNull();
  expect(readRemoteConnectionState(locationOf(env))).toBeNull();
});

test.each([
  {
    status: 402,
    body: {
      error: 'insufficient_balance',
      requiredUsdMicros: '200000',
      availableUsdMicros: '50000',
      shortfallUsdMicros: '150000',
      topUpUrl: 'https://cloud.example/app/billing#top-up',
    },
  },
  { status: 402, body: {} },
  {
    status: 422,
    body: { error: 'budget_exceeded', maxUsdMicros: '100000', minimumUsdMicros: '200000' },
  },
])('money rejection $status preserves its details and permits a changed cap', async (rejection) => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(Response.json(rejection.body, { status: rejection.status }));
  const refused = await runCliCapture(cappedArgs, { env });
  const { error } = JSON.parse(refused.stdout);
  expect(error.code).toBe('INVALID_ARGS');
  expect(error.hint).toEqual(expect.stringMatching(/^(Top up|Raise --max-usd)/));
  expect(error.details).toEqual({
    status: rejection.status,
    reason: rejection.status === 422 ? 'budget_exceeded' : 'insufficient_balance',
    ...Object.fromEntries(Object.entries(rejection.body).filter(([key]) => key !== 'error')),
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readCloudConnection(locationOf(env))).toBeNull();
  const changed = await runCliCapture([...connectArgs, '--max-usd', '0.75'], { env });
  expect(changed.code, changed.stdout).toBeNull();
  expect(postKey(fetchMock.mock.calls[1]![1])).not.toBe(postKey(fetchMock.mock.calls[0]![1]));
});

test.each(['0', '1e2', '0.0000001', '-1'])(
  'refuses --max-usd %s before contacting the cloud API',
  async (value) => {
    const fetchMock = stubCloudApi();
    const refused = await runCliCapture([...connectArgs, `--max-usd=${value}`], {
      env: cloudEnv(),
    });
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'cloud_invalid_max_usd' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test('refuses --max-usd outside connect cloud', async () => {
  const fetchMock = stubCloudApi();
  const refused = await runCliCapture(
    ['connect', 'proxy', '--daemon-base-url', 'https://proxy.example', '--max-usd', '1', '--json'],
    { env: cloudEnv() },
  );
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'INVALID_ARGS',
    message: expect.stringContaining('--max-usd'),
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('validates the provider name before applying cloud-only flag rules', async () => {
  const fetchMock = stubCloudApi();
  const refused = await runCliCapture(
    ['connect', 'browserstrack', '--vendor', 'provider-a', '--platform', 'ios', '--json'],
    { env: cloudEnv() },
  );
  expect(JSON.parse(refused.stdout).error.message).toContain(
    'Unknown connect provider: browserstrack',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

test('refuses a project config cap before contacting the cloud API', async () => {
  const project = mkdtempForTestSync('agent-device-cloud-project-');
  fs.writeFileSync(path.join(project, 'agent-device.json'), JSON.stringify({ maxUsd: '0.50' }));
  const fetchMock = stubCloudApi();
  const refused = await runCliCapture(connectArgs, { env: cloudEnv(), cwd: project });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'INVALID_ARGS',
    message: expect.stringContaining('"maxUsd" is not allowed in project config'),
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a definitive response to a resumed request does not erase an earlier uncertain POST', async () => {
  const env = cloudEnv();
  const broker = stubCloudApi();
  timeOutNextCreate(broker);
  expect((await runCliCapture(cappedArgs, { env })).code).toBe(1);
  vi.restoreAllMocks();
  const pending = readCloudConnection(locationOf(env));
  const retry = broker
    .mockResolvedValueOnce(Response.json({ error: 'budget_exceeded' }, { status: 422 }))
    .mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
  expect((await runCliCapture(cappedArgs, { env })).code).toBe(1);
  expect(readCloudConnection(locationOf(env))).toEqual(pending);
  expect(retry.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'POST', 'GET']);
});
