import { afterEach, expect, test, vi } from 'vitest';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { readCloudConnection } from '../cli/connection/cloud-connection-record.ts';
import { runCliCapture } from './cli-capture.ts';
import {
  cloudEnv,
  connectArgs,
  hostedDevice,
  locationOf,
  stubCloudApi,
} from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([
  { failure: 'account-scoped 404', reply: Response.json({ error: 'not_found' }, { status: 404 }) },
  { failure: 'generic 404', reply: new Response('<h1>Not Found</h1>', { status: 404 }) },
  { failure: '401', reply: new Response(null, { status: 401 }) },
  { failure: '503', reply: new Response(null, { status: 503 }) },
  { failure: 'network error' },
  {
    failure: '409 with a live session',
    reply: new Response(null, { status: 409 }),
    session: { id: hostedDevice.id, state: 'running' },
  },
  {
    failure: '409 with a different settled session',
    reply: new Response(null, { status: 409 }),
    session: { id: '00000000-0000-4000-8000-000000000002', state: 'settled' },
  },
])('disconnect retains ownership after $failure', async ({ reply, session }) => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const record = readCloudConnection(location);
  const connection = readRemoteConnectionState(location);
  expect(record).toMatchObject({ phase: 'committed', id: hostedDevice.id });
  expect(connection?.cloudSession?.id).toBe(hostedDevice.id);

  if (reply) fetchMock.mockResolvedValueOnce(reply);
  else fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
  if (session) fetchMock.mockResolvedValueOnce(Response.json(session));
  const refused = await runCliCapture(['disconnect', '--json'], { env });
  expect(refused.code).toBe(1);
  if (reply?.status === 404) {
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      details: { reason: 'cloud_session_not_found', status: 404 },
      hint: expect.stringMatching(/retry agent-device disconnect.*disconnect --forget/),
    });
  }
  expect(readCloudConnection(location)).toEqual({ ...record, phase: 'closing' });
  expect(readRemoteConnectionState(location)).toEqual(connection);

  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [init.method, url.pathname])).toEqual(
    ['DELETE', ...(session ? ['GET'] : []), 'DELETE'].map((method) => [
      method,
      `/v1/sessions/${hostedDevice.id}`,
    ]),
  );
  expect(readCloudConnection(location)).toBeNull();
  expect(readRemoteConnectionState(location)).toBeNull();
});
