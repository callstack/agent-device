import { afterEach, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { fetchOverDirectHttp, fetchWithCredential, loadDirectHttpAgent } from './direct-http.ts';
import { loadNodeHttpRequester } from './transport.ts';

// A credential sent over plain http goes only to loopback, and an environment proxy on another host
// would read it in cleartext. Node reads `NODE_USE_ENV_PROXY` at startup, so each case runs a child.

async function listenLocal(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closeLocal(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => closeLocal(server)));
});

async function serve(seen: string[]): Promise<number> {
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.end('ok');
  });
  servers.push(server);
  return await listenLocal(server);
}

const TRANSPORT = path.join(import.meta.dirname, 'direct-http.ts');

async function runChild(script: string, proxyPort: number): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: '',
        no_proxy: '',
      },
    },
  );
  return stdout.trim();
}

test.each([
  [
    'node:http with loadDirectHttpAgent',
    (target: string) => `
      import http from 'node:http';
      import { loadDirectHttpAgent } from ${JSON.stringify(TRANSPORT)};
      const agent = await loadDirectHttpAgent('http:');
      await new Promise((resolve, reject) => {
        const req = http.request(${JSON.stringify(target)}, { agent, headers: { authorization: 'Bearer secret' } }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
      });
      console.log('sent');`,
  ],
  [
    'fetchWithCredential',
    (target: string) => `
      import { fetchWithCredential } from ${JSON.stringify(TRANSPORT)};
      const response = await fetchWithCredential(${JSON.stringify(target)}, { headers: { authorization: 'Bearer secret' } });
      console.log(await response.text() === 'ok' ? 'sent' : 'bad');`,
  ],
  [
    'fetchOverDirectHttp',
    (target: string) => `
      import { fetchOverDirectHttp } from ${JSON.stringify(TRANSPORT)};
      const response = await fetchOverDirectHttp(new Request(${JSON.stringify(target)}, { headers: { authorization: 'Bearer secret' } }));
      console.log(await response.text() === 'ok' ? 'sent' : 'bad');`,
  ],
])('%s reaches loopback directly, never through an environment proxy', async (_label, script) => {
  const proxied: string[] = [];
  const direct: string[] = [];
  const proxyPort = await serve(proxied);
  const targetPort = await serve(direct);

  const output = await runChild(script(`http://127.0.0.1:${targetPort}/rpc`), proxyPort);

  expect(output).toBe('sent');
  expect(proxied).toEqual([]);
  expect(direct).toEqual(['GET /rpc Bearer secret']);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/** A loopback server that answers as `respond` does and records what its connections saw. */
async function serveWith(respond: http.RequestListener) {
  const closed = deferred();
  const server = http.createServer((req, res) => {
    res.on('close', () => closed.resolve());
    respond(req, res);
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${await listenLocal(server)}`;
  return { origin, closed: closed.promise };
}

const stayQuiet: http.RequestListener = () => {};
const sendHalf: http.RequestListener = (_req, res) => void res.write('half');

test('a post declares its length and returns a redirect without following it', async () => {
  const seen: string[] = [];
  const target = await serveWith((req, res) => {
    seen.push(req.url ?? '');
    res.end();
  });
  const { origin } = await serveWith((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      seen.push(`${req.headers['content-length']} ${body}`);
      res.writeHead(307, { location: `${target.origin}/moved` }).end();
    });
  });

  const response = await fetchWithCredential(origin, {
    method: 'POST',
    body: 'payload',
    redirect: 'manual',
  });

  expect(response.status).toBe(307);
  await expect(
    fetchWithCredential(origin, { method: 'POST', body: 'payload', redirect: 'error' }),
  ).rejects.toThrow(TypeError);
  expect(seen).toEqual(['7 payload', '7 payload']);
});

test('a refused connection rejects as fetch does, with the socket error as the cause', async () => {
  const server = http.createServer();
  const port = await listenLocal(server);
  await closeLocal(server);

  await expect(fetchWithCredential(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
    name: 'TypeError',
    message: 'fetch failed',
    cause: { code: 'ECONNREFUSED' },
  });
});

test('an abort before the response rejects with its reason and closes the connection', async () => {
  const received = deferred();
  const { origin, closed } = await serveWith(() => received.resolve());
  const controller = new AbortController();
  const reason = new Error('caller gave up');

  const pending = fetchWithCredential(origin, { signal: controller.signal });
  await received.promise;
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await closed;
});

test('an abort during the response body fails the read and closes the connection', async () => {
  const { origin, closed } = await serveWith(sendHalf);
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const response = await fetchWithCredential(origin, { signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();

  const pending = reader.read();
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await closed;
});

/** Runs the real socket timeout at 20 ms, and records the bound the request asked for. */
function shortenIdleTimeout(): unknown[] {
  const asked: unknown[] = [];
  const request = http.request;
  vi.spyOn(http, 'request').mockImplementation(((
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) => {
    asked.push(options.timeout);
    return request({ ...options, timeout: 20 }, callback);
  }) as typeof http.request);
  return asked;
}

const idleTimeout = { details: { reason: 'direct_http_idle_timeout' } };

test('a peer that never answers ends the request with the idle timeout', async () => {
  const { origin, closed } = await serveWith(stayQuiet);
  const asked = shortenIdleTimeout();

  await expect(fetchOverDirectHttp(new Request(origin))).rejects.toMatchObject(idleTimeout);

  await closed;
  expect(asked).toEqual([300_000]);
});

test('a body that goes silent fails the read with the idle timeout', async () => {
  const { origin, closed } = await serveWith(sendHalf);
  shortenIdleTimeout();
  const response = await fetchWithCredential(origin);

  await expect(response.text()).rejects.toMatchObject(idleTimeout);
  await closed;
});

test('the credential requester keeps its direct agent whatever the options name', async () => {
  const { origin } = await serveWith((_req, res) => void res.end());
  const direct = await loadDirectHttpAgent('http:');
  const request = vi.spyOn(http, 'request');
  const requester = await loadNodeHttpRequester('http:', 'direct');

  for (const agent of [undefined, new http.Agent()]) {
    const options: http.RequestOptions = { host: '127.0.0.1', port: new URL(origin).port, agent };
    await new Promise<void>((resolve, reject) => {
      const sent = requester.request(options, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      sent.on('error', reject);
      sent.end();
    });
  }

  expect(request.mock.calls.map(([options]) => (options as http.RequestOptions).agent)).toEqual([
    direct,
    direct,
  ]);
});

/** A server that records each upload's framing and body, and reports its first bytes. */
async function serveUpload() {
  const uploads: Array<{ length?: string; encoding?: string; body: string }> = [];
  const started = deferred();
  const { origin, closed } = await serveWith((req, res) => {
    const upload = {
      length: req.headers['content-length'],
      encoding: req.headers['transfer-encoding'],
      body: '',
    };
    uploads.push(upload);
    req.on('data', (chunk) => {
      upload.body += String(chunk);
      started.resolve();
    });
    req.on('end', () => res.end());
  });
  return { origin, closed, uploads, started: started.promise };
}

test.each([
  ['declares the length its headers give', { 'content-length': '12' }, '12', undefined],
  ['is chunked without a declared length', undefined, undefined, 'chunked'],
])('a streamed body is sent as it arrives and %s', async (_label, headers, length, encoding) => {
  const server = await serveUpload();
  async function* body() {
    yield Buffer.from('first,');
    // A sender that read the whole body first would never get here.
    await server.started;
    yield Buffer.from('second');
  }

  const response = await fetchWithCredential(server.origin, {
    method: 'PUT',
    ...(headers ? { headers } : {}),
    body: body() as unknown as BodyInit,
    duplex: 'half',
  } as RequestInit);

  expect(response.status).toBe(200);
  expect(server.uploads).toEqual([{ length, encoding, body: 'first,second' }]);
});

/** One chunk, then silence; `release` runs when the stream is cancelled or destroyed. */
const stalledStreams: Array<[string, (release: () => void) => unknown]> = [
  [
    'a web stream',
    (release) =>
      new ReadableStream<Uint8Array>({
        start: (stream) => stream.enqueue(Buffer.from('first,')),
        cancel: release,
      }),
  ],
  [
    'a Node stream',
    (release) => {
      const stream = new Readable({
        read: () => {},
        destroy: (error, done) => {
          release();
          done(error);
        },
      });
      stream.push('first,');
      return stream;
    },
  ],
];

test.each(stalledStreams)('an abort during an upload releases %s', async (_label, source) => {
  const server = await serveUpload();
  const released = deferred();
  const controller = new AbortController();
  const reason = new Error('caller gave up');

  const pending = fetchWithCredential(server.origin, {
    method: 'PUT',
    body: source(released.resolve) as BodyInit,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit);
  await server.started;
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await released.promise;
  await server.closed;
});

test('a streamed body that fails rejects the request as fetch does', async () => {
  const server = await serveUpload();
  const failure = new Error('disk gone');
  async function* body() {
    yield Buffer.from('first,');
    throw failure;
  }

  await expect(
    fetchWithCredential(server.origin, {
      method: 'PUT',
      body: body() as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit),
  ).rejects.toMatchObject({ message: 'fetch failed', cause: failure });
});
