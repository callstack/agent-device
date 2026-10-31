import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { NomacClient } from './client.ts';
import { fakeNomac } from './fake-nomac.fixtures.ts';

const client = (fetch: typeof globalThis.fetch) =>
  new NomacClient({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch,
  });

test("a tool call is polled until it ends, and a build's job is followed to its end", async () => {
  let polls = 0;
  const seen: string[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    seen.push(`${init.method ?? 'GET'} ${path}`);
    if (path.endsWith('/tools/app_run')) return Response.json({ id: 'call_1', state: 'running' });
    if (path.endsWith('/calls/call_1'))
      return Response.json(
        ++polls < 2
          ? { id: 'call_1', state: 'running' }
          : {
              state: 'done',
              result: {
                content: [{ type: 'text', text: 'Building.\nNext: job_status {job_id: "job_9"}' }],
              },
            },
      );
    if (path.endsWith('/tools/job_status'))
      return Response.json({
        state: 'done',
        result: { content: [{ type: 'text', text: 'Launched Demo.' }] },
      });
    return Response.json({}, { status: 404 });
  }) as typeof globalThis.fetch;
  const result = await client(fetch).tool('ses_1', 'app_run', { path: '/w' });
  expect(result).toMatchObject({ text: 'Launched Demo.', isError: false });
  expect(seen.filter((s) => s.endsWith('/tools/app_run'))).toHaveLength(1);
});

test("NoMac's refusals become agent-device errors with NoMac's code kept; only safe requests are sent again", async () => {
  let starts = 0;
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/v1/simulator/sessions' && init.method === 'POST') {
      return ++starts < 2
        ? new Response('{}', { status: 503 })
        : Response.json(
            {
              error: {
                code: 'simulator_unavailable',
                message: 'NoMac Simulator is not available for this account yet.',
              },
            },
            { status: 403 },
          );
    }
    return Response.json(
      { error: { code: 'session_limit_reached', message: 'This account already runs 2 phones.' } },
      { status: 409 },
    );
  }) as typeof globalThis.fetch;
  await expect(client(fetch).startPhone('agent-device-lease-x', {})).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    details: { nomacCode: 'simulator_unavailable', status: 403 },
  });
  expect(starts).toBe(2);
  // A request without a key (the phones' list is a read and is retried; a tool call carries its own key).
  await expect(
    client(fetch).request('POST', '/api/v1/simulator/webhooks', { body: {} }),
  ).rejects.toBeInstanceOf(AppError);
});

test('an archive goes to its upload link without the key, then is unpacked', async () => {
  const nomac = fakeNomac();
  const c = client(nomac.fetch);
  const phone = await c.startPhone('agent-device-lease-y', { label: 'agent-device-y' });
  const unpacked = await c.uploadArchive(phone.id, Buffer.from('archive'), 'agent-device-app');
  expect(unpacked).toEqual({
    root: '/Volumes/nmw-x/src/agent-device-app',
    app: '/Volumes/nmw-x/src/agent-device-app/Demo.app',
  });
  const put = nomac.seen.find((r) => r.method === 'PUT');
  expect(put?.auth).toBeNull();
  expect(nomac.seen.find((r) => r.path.endsWith('/sync/upload'))?.body).toMatchObject({ size: 7 });
  await expect(c.download('https://elsewhere.test/x')).rejects.toBeInstanceOf(AppError);
});

test('a phone is found by its label, read and stopped, the label sent encoded', async () => {
  const seen: string[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (
      url.pathname === '/api/v1/simulator/sessions' &&
      url.searchParams.get('label') === 'lease/1'
    )
      return Response.json({ sessions: [{ id: 'ses_1', state: 'ready' }] });
    if (url.pathname === '/api/v1/simulator/sessions/ses_1')
      return Response.json({
        session: { id: 'ses_1', state: init.method === 'DELETE' ? 'stopping' : 'ready' },
      });
    return Response.json({}, { status: 404 });
  }) as typeof globalThis.fetch;
  const nomac = client(fetch);
  expect(await nomac.phonesWithLabel('lease/1')).toMatchObject([{ id: 'ses_1' }]);
  expect(await nomac.readPhone('ses_1')).toMatchObject({ state: 'ready' });
  expect(await nomac.stopPhone('ses_1')).toMatchObject({ state: 'stopping' });
  expect(seen).toEqual([
    'GET /api/v1/simulator/sessions?label=lease%2F1',
    'GET /api/v1/simulator/sessions/ses_1',
    'DELETE /api/v1/simulator/sessions/ses_1',
  ]);
});
