import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import {
  cloudAttachmentPath,
  readCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
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
  const { error } = JSON.parse(refused.stdout);
  expect(error.hint).toMatch(/retry.*disconnect --forget/i);
  if (reply?.status === 404) {
    expect(error.details).toMatchObject({ reason: 'cloud_session_not_found', status: 404 });
    expect(error.cause).toBeUndefined();
  }
  expect(readCloudConnection(location)).toEqual(record);
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

test('disconnect resumes local cleanup if the closing record write fails after release', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const broker = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();

  const writeFile = fs.writeFileSync;
  let proofWrites = 0;
  const write = vi
    .spyOn(fs, 'writeFileSync')
    .mockImplementation((destination, contents, options) => {
      if (typeof contents === 'string' && contents.includes('"brokerReleased":true')) {
        if (contents.includes('"phase":"closing"') || ++proofWrites === 1) {
          throw Object.assign(new Error('fixture record write failure'), { code: 'EIO' });
        }
      }
      writeFile(destination, contents, options);
    });
  const failed = await runCliCapture(['disconnect', '--json'], { env });
  write.mockRestore();
  expect(failed.code).toBe(1);
  expect(proofWrites).toBe(2);
  expect(readCloudConnection(location)).toMatchObject({
    id: hostedDevice.id,
    brokerReleased: true,
  });
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(true);
  const blocked = await runCliCapture(['snapshot', '--json'], { env });
  expect(JSON.parse(blocked.stdout).error.details.reason).toBe('cloud_connection_changed');

  broker.mockResolvedValueOnce(new Response(null, { status: 404 }));
  const retried = await runCliCapture(['disconnect', '--json'], { env });
  expect(retried.code, retried.stdout).toBeNull();
  expect(broker.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
  expect(readCloudConnection(location)).toBeNull();
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
});

test.each([
  { status: undefined, cause: new DOMException('Timed out waiting for DELETE', 'TimeoutError') },
  { status: 503, cause: new Error('Response body connection closed') },
])(
  'disconnect preserves the broker release failure cause and status ($status)',
  async ({ status, cause }) => {
    const env = cloudEnv();
    const broker = stubCloudApi();
    expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
    if (status === undefined) broker.mockRejectedValueOnce(cause);
    else {
      const body = new ReadableStream({ start: (stream) => stream.error(cause) });
      broker.mockResolvedValueOnce(new Response(body, { status }));
    }

    const result = await runCliCapture(['disconnect', '--json'], { env });
    expect(result.code).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error).toMatchObject({ code: 'COMMAND_FAILED', cause: { message: cause.message } });
    expect(error.details?.status).toBe(status);
  },
);
