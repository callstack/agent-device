import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { NomacClient, type NomacBudgets } from './client.ts';
import { fakeNomac } from './fake-nomac.fixtures.ts';

const client = (fetch: typeof globalThis.fetch, budgets?: Partial<NomacBudgets>) =>
  new NomacClient({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch,
    budgets,
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
});

test('a POST without a request key is sent once, even when NoMac is busy', async () => {
  let posts = 0;
  const fetch = (async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname === '/api/v1/simulator/webhooks') posts++;
    return Response.json({ error: { code: 'busy', message: 'NoMac is busy.' } }, { status: 503 });
  }) as typeof globalThis.fetch;
  await expect(
    client(fetch).request('POST', '/api/v1/simulator/webhooks', { body: {} }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { nomacCode: 'busy', status: 503 },
  });
  expect(posts).toBe(1);
});

test('a job still running when job_status answers is followed, and one past the budget fails', async () => {
  const answers = [
    'Building Demo is still building after 40 s: job job_9.\nNext: job_status {job_id: "job_9"}; it waits up to 40 s for the result.',
    'Building Demo: compiling, 1 m 20 s so far (job_9).\nNext: job_status again, or job_cancel.',
    'Built Demo in 95 s, installed dev.simtap.demo.',
  ];
  // app_run answers the job; each job_status answers the next text, the last one again once they run out.
  const fetchWith = (texts: string[]) => {
    let next = 1;
    return (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const text = path.endsWith('/tools/app_run')
        ? texts[0]!
        : texts[Math.min(next++, texts.length - 1)]!;
      return Response.json({ state: 'done', result: { content: [{ type: 'text', text }] } });
    }) as typeof globalThis.fetch;
  };
  const result = await client(fetchWith([...answers])).tool('ses_1', 'app_run', { path: '/w' });
  expect(result.text).toBe('Built Demo in 95 s, installed dev.simtap.demo.');
  await expect(
    client(fetchWith([answers[0]!, answers[1]!]), { jobMs: 0 }).tool('ses_1', 'app_run', {}),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { nomacJob: 'job_9' } });
});

test('a tool call that stays running past its budget fails instead of hanging', async () => {
  const fetch = (async (input: string | URL | Request) =>
    new URL(String(input)).pathname.includes('/calls/')
      ? Response.json({ id: 'call_1', state: 'running' })
      : Response.json({ id: 'call_1', state: 'running' })) as typeof globalThis.fetch;
  await expect(client(fetch, { callMs: 0 }).tool('ses_1', 'ui_look', {})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { nomacCall: 'call_1' },
  });
});

test('a file link or upload that fails on the network is a typed error', async () => {
  const fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof globalThis.fetch;
  await expect(
    client(fetch).download('https://nomac.test/api/v1/simulator/files/x'),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  const controller = new AbortController();
  controller.abort();
  await expect(
    client(fetch).download('https://nomac.test/api/v1/simulator/files/x', controller.signal),
  ).rejects.toBeInstanceOf(TypeError);
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
