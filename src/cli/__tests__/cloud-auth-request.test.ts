import { afterEach, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalizeError } from '@agent-device/kernel/errors';
import { postCloudAuthJson } from '../cloud-auth-request.ts';

// These tests use Node's own fetch against loopback servers, so they prove that no redirect is
// followed by fetch itself and that a refused target never receives a request.

type Received = { method?: string; path?: string; body: string; contentType?: string };
/** A canned response. Routes are data, so no handler is ever chosen by the request path. */
type Route = { status: number; headers: Record<string, string>; body: string };

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen() {
  const received: Received[] = [];
  const routes = new Map<string, Route | Route[]>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        path: req.url,
        body,
        contentType: req.headers['content-type'],
      });
      const entry = routes.get(req.url ?? '');
      // A queue serves its responses in order and keeps repeating the last one.
      const route = Array.isArray(entry) && entry.length > 1 ? entry.shift() : [entry].flat()[0];
      if (route === undefined) return void res.writeHead(404).end();
      res.writeHead(route.status, route.headers).end(route.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, received, routes };
}

const redirect = (status: number, location?: string): Route => ({
  status,
  headers: location === undefined ? {} : { location },
  body: '',
});
const answer: Route = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"accessToken":"adc_agent"}',
};

const BODY = { deviceCode: 'device-secret' };
const post = (origin: string) =>
  postCloudAuthJson<{ accessToken: string }>({ baseUrl: origin, pathName: '/start', body: BODY });
const posted = (path: string) => ({
  method: 'POST',
  path,
  body: JSON.stringify(BODY),
  contentType: 'application/json',
});
const fetchedAsGet = (path: string) => ({ method: 'GET', path, body: '', contentType: undefined });

test.each([
  [307, posted('/next')],
  [308, posted('/next')],
  [301, fetchedAsGet('/next')],
  [302, fetchedAsGet('/next')],
  [303, fetchedAsGet('/next')],
])('a same-origin %i is followed with the method fetch gives it', async (status, followed) => {
  const cloud = await listen();
  cloud.routes.set('/start', redirect(status, '/next'));
  cloud.routes.set('/next', answer);

  expect(await post(cloud.origin)).toEqual({ accessToken: 'adc_agent' });
  expect(cloud.received).toEqual([posted('/start'), followed]);
});

test.each([
  [301, fetchedAsGet('/start')],
  [302, fetchedAsGet('/start')],
  [303, fetchedAsGet('/start')],
  [307, posted('/start')],
  [308, posted('/start')],
])(
  'an empty Location on a %i redirects to the same URL, as fetch does',
  async (status, followed) => {
    const cloud = await listen();
    cloud.routes.set('/start', [redirect(status, ''), answer]);

    expect(await post(cloud.origin)).toEqual({ accessToken: 'adc_agent' });
    expect(cloud.received).toEqual([posted('/start'), followed]);
  },
);

test('a chain keeps the POST through a 307 and stays a GET after a 303', async () => {
  const cloud = await listen();
  cloud.routes.set('/start', redirect(307, '/a'));
  cloud.routes.set('/a', redirect(303, '/b'));
  cloud.routes.set('/b', redirect(307, '/c'));
  cloud.routes.set('/c', answer);

  await post(cloud.origin);
  expect(cloud.received).toEqual([
    posted('/start'),
    posted('/a'),
    fetchedAsGet('/b'),
    fetchedAsGet('/c'),
  ]);
});

test('three same-origin redirects are followed and a fourth is refused', async () => {
  const cloud = await listen();
  cloud.routes.set('/start', redirect(307, '/1'));
  cloud.routes.set('/1', redirect(307, '/2'));
  cloud.routes.set('/2', redirect(307, '/3'));
  cloud.routes.set('/3', answer);
  expect(await post(cloud.origin)).toEqual({ accessToken: 'adc_agent' });

  cloud.routes.set('/3', redirect(307, '/4'));
  cloud.routes.set('/4', answer);
  cloud.received.length = 0;
  await expect(post(cloud.origin)).rejects.toMatchObject({
    details: { reason: 'cloud_auth_redirect_refused' },
  });
  expect(cloud.received.map(({ path }) => path)).toEqual(['/start', '/1', '/2', '/3']);
});

test.each([
  ['no Location', () => undefined],
  ['a username', (host: string) => `http://device-secret@${host}/next`],
  ['a password', (host: string) => `http://user:device-secret@${host}/next`],
  ['another origin', (_host: string, other: string) => `${other}/next`],
])(
  'a redirect to %s is refused before anything is sent, without quoting the target',
  async (_case, location) => {
    const cloud = await listen();
    const other = await listen();
    cloud.routes.set('/start', redirect(307, location(new URL(cloud.origin).host, other.origin)));
    cloud.routes.set('/next', answer);
    other.routes.set('/next', answer);

    const rejection = await post(cloud.origin).then(
      () => undefined,
      (error: unknown) => normalizeError(error),
    );
    expect(rejection?.details?.reason).toBe('cloud_auth_redirect_refused');
    expect(JSON.stringify(rejection)).not.toContain('device-secret');
    expect(cloud.received.map(({ path }) => path)).toEqual(['/start']);
    expect(other.received).toEqual([]);
  },
);
