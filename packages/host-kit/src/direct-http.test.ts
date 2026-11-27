import { afterEach, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import dns from 'node:dns';
import net, { type AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { fetchWithCredential, loadDirectHttpAgent, type CredentialSend } from './direct-http.ts';
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
      const agent = await loadDirectHttpAgent();
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
      const response = await fetchWithCredential(${JSON.stringify(target)}, { headers: { authorization: 'Bearer secret' } }, { subject: 'Test URL' });
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

/** One request through the primitive, as a caller with no transport of its own sends it. */
function send(url: string, init: RequestInit = {}, options: Partial<CredentialSend> = {}) {
  return fetchWithCredential(url, init, { subject: 'Test URL', ...options });
}

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

  const response = await send(origin, {
    method: 'POST',
    body: 'payload',
    redirect: 'manual',
  });

  expect(response.status).toBe(307);
  await expect(
    send(origin, { method: 'POST', body: 'payload', redirect: 'error' }),
  ).rejects.toThrow(TypeError);
  expect(seen).toEqual(['7 payload', '7 payload']);
});

test('a refused connection rejects as fetch does, with the socket error as the cause', async () => {
  const server = http.createServer();
  const port = await listenLocal(server);
  await closeLocal(server);

  await expect(send(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
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

  const pending = send(origin, { signal: controller.signal });
  await received.promise;
  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await closed;
});

test('an abort during the response body fails the read and closes the connection', async () => {
  const { origin, closed } = await serveWith(sendHalf);
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const response = await send(origin, { signal: controller.signal });
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

  await expect(send(origin)).rejects.toMatchObject(idleTimeout);

  await closed;
  expect(asked).toEqual([300_000]);
});

test('a body that goes silent fails the read with the idle timeout', async () => {
  const { origin, closed } = await serveWith(sendHalf);
  shortenIdleTimeout();
  const response = await send(origin);

  await expect(response.text()).rejects.toMatchObject(idleTimeout);
  await closed;
});

test('the credential requester keeps its direct agent whatever the options name', async () => {
  const { origin } = await serveWith((_req, res) => void res.end());
  const pooled = await loadDirectHttpAgent();
  const request = vi.spyOn(http, 'request');
  const requester = await loadNodeHttpRequester(new URL(origin), { subject: 'Test URL' });

  for (const agent of [undefined, new http.Agent(), false as const]) {
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

  const used = request.mock.calls.map(([options]) => (options as http.RequestOptions).agent);
  expect(used.slice(0, 2)).toEqual([pooled, pooled]);
  // `agent: false` asks for a connection of its own, still a direct one.
  expect(used[2]).not.toBe(pooled);
  expect(used[2]).toBeInstanceOf(http.Agent);
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

  const response = await send(server.origin, {
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

  const pending = send(server.origin, {
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

test.each(stalledStreams)(
  'an upload aborted before it starts releases %s and sends nothing',
  async (_label, source) => {
    const server = await serveUpload();
    const released = deferred();
    const reason = new Error('caller gave up');

    await expect(
      send(server.origin, {
        method: 'PUT',
        body: source(released.resolve) as BodyInit,
        signal: AbortSignal.abort(reason),
        duplex: 'half',
      } as RequestInit),
    ).rejects.toBe(reason);

    await released.promise;
    expect(server.uploads).toEqual([]);
  },
);

test('a streamed body that fails rejects the request as fetch does', async () => {
  const server = await serveUpload();
  const failure = new Error('disk gone');
  async function* body() {
    yield Buffer.from('first,');
    throw failure;
  }

  await expect(
    send(server.origin, {
      method: 'PUT',
      body: body() as unknown as BodyInit,
      duplex: 'half',
    } as RequestInit),
  ).rejects.toMatchObject({ message: 'fetch failed', cause: failure });
});

/** A loopback server answering each path from `routes`, recording every request it gets. */
async function serveRoutes(routes: Record<string, [number, Record<string, string>, string?]>) {
  const received: string[] = [];
  const { origin } = await serveWith((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      received.push(
        [req.method, req.url, req.headers.authorization, req.headers['content-type'], body].join(
          ' ',
        ),
      );
      const [status, headers, answer] = routes[req.url ?? ''] ?? [200, {}, 'done'];
      res.writeHead(status, headers).end(answer);
    });
  });
  return { origin, received };
}

const credentialPost = {
  method: 'POST',
  headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' },
  body: 'payload',
};

test.each([
  [307, 'POST /moved Bearer secret text/plain payload'],
  [308, 'POST /moved Bearer secret text/plain payload'],
  [301, 'GET /moved Bearer secret  '],
  [303, 'GET /moved Bearer secret  '],
])('a same-origin %i is followed as fetch would send it', async (status, followed) => {
  const server = await serveRoutes({ '/start': [status, { location: '/moved' }] });

  const response = await send(`${server.origin}/start`, credentialPost);

  expect(await response.text()).toBe('done');
  expect(server.received).toEqual(['POST /start Bearer secret text/plain payload', followed]);
});

test('a redirect off the origin is returned as the answer, and its target gets nothing', async () => {
  const other = await serveRoutes({});
  const server = await serveRoutes({
    '/start': [307, { location: `${other.origin}/moved` }],
    '/user': [307, { location: '//user:password@127.0.0.1/moved' }],
  });

  for (const path of ['/start', '/user']) {
    expect((await send(`${server.origin}${path}`, credentialPost)).status).toBe(307);
  }
  expect(other.received).toEqual([]);
});

test('an https request redirected to plain http is returned, not followed', async () => {
  const sent: string[] = [];
  const response = await send('https://remote.example/start', credentialPost, {
    send: async (input) => {
      sent.push(String(input));
      return new Response(null, {
        status: 307,
        headers: { location: 'http://remote.example/start' },
      });
    },
  });

  expect(response.status).toBe(307);
  expect(sent).toEqual(['https://remote.example/start']);
});

test('a redirect loop ends after three hops, and a Request is sent once', async () => {
  const server = await serveRoutes({ '/loop': [307, { location: '/loop' }] });

  expect((await send(`${server.origin}/loop`)).status).toBe(307);
  expect(server.received).toHaveLength(4);

  const once = await fetchWithCredential(
    new Request(`${server.origin}/loop`),
    {},
    { subject: 'x' },
  );
  expect(once.status).toBe(307);
  expect(server.received).toHaveLength(5);
});

test.each(['http://10.0.0.7/start', 'http://[fd00::1]/start', 'not a url'])(
  '%s is refused before any transport sees it',
  async (url) => {
    const transport = vi.fn();
    const request = vi.spyOn(http, 'request');

    for (const options of [{}, { send: transport }]) {
      await expect(send(url, credentialPost, options)).rejects.toMatchObject({
        details: { reason: 'insecure_credential_transport', dispatched: 'no' },
      });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  },
);

/** Makes the resolver answer `localhost` with `address`, in both callback shapes. */
function resolveLocalhostTo(address: string): void {
  vi.spyOn(dns, 'lookup').mockImplementation(((
    _hostname: string,
    options: dns.LookupOptions,
    callback: (...answer: unknown[]) => void,
  ) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  }) as typeof dns.lookup);
}

test('localhost that resolves off loopback receives nothing, on every direct agent', async () => {
  const server = await serveRoutes({});
  const url = new URL(server.origin.replace('127.0.0.1', 'localhost'));
  // `0.0.0.0` reaches this machine's listener and is not a loopback address.
  resolveLocalhostTo('0.0.0.0');
  const refused = { details: { reason: 'insecure_credential_transport' } };

  await expect(send(url.href, credentialPost)).rejects.toMatchObject(refused);
  const requester = await loadNodeHttpRequester(url, { subject: 'Test URL' });
  for (const agent of [undefined, false as const]) {
    await expect(
      new Promise((resolve, reject) => {
        const sent = requester.request(
          { host: url.hostname, port: url.port, agent, headers: credentialPost.headers },
          resolve,
        );
        sent.on('error', reject);
        sent.end();
      }),
    ).rejects.toMatchObject(refused);
  }
  expect(server.received).toEqual([]);
});

test('localhost that resolves to loopback is reached', async () => {
  const server = await serveRoutes({});
  resolveLocalhostTo('127.0.0.1');

  const response = await send(server.origin.replace('127.0.0.1', 'localhost'));

  expect(await response.text()).toBe('done');
});

const PLAIN = 'compressed '.repeat(200);

test.each([
  ['gzip', zlib.gzipSync(PLAIN)],
  ['x-gzip', zlib.gzipSync(PLAIN)],
  ['deflate', zlib.deflateSync(PLAIN)],
  ['deflate', zlib.deflateRawSync(PLAIN)],
  ['br', zlib.brotliCompressSync(PLAIN)],
  ['gzip, br', zlib.brotliCompressSync(zlib.gzipSync(PLAIN))],
])('a %s answer is decoded, with the headers of the decoded body', async (encoding, bytes) => {
  const { origin } = await serveWith((_req, res) => {
    res.writeHead(200, { 'content-encoding': encoding, 'content-length': bytes.length }).end(bytes);
  });

  const response = await send(origin);

  expect(await response.text()).toBe(PLAIN);
  expect(response.headers.get('content-encoding')).toBe(null);
  expect(response.headers.get('content-length')).toBe(null);
});

test('a coding fetch does not decode is passed through with its headers', async () => {
  const { origin } = await serveWith((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'compress', 'content-length': '5' }).end('bytes');
  });

  const response = await send(origin);

  expect(await response.text()).toBe('bytes');
  expect(response.headers.get('content-encoding')).toBe('compress');
});

test('a damaged compressed answer fails the read', async () => {
  const { origin } = await serveWith((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' }).end('not gzip');
  });

  await expect((await send(origin)).text()).rejects.toThrow();
});

test('an abort during a compressed answer fails the read with its reason', async () => {
  const { origin, closed } = await serveWith((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.write(zlib.gzipSync(PLAIN).subarray(0, 20));
  });
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const pending = (await send(origin, { signal: controller.signal })).text();

  controller.abort(reason);

  await expect(pending).rejects.toBe(reason);
  await closed;
});

test('a CoreDevice tunnel request goes to the bracketed address through node:http', async () => {
  const seen: string[] = [];
  const standIn = await serveWith((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.host} ${req.headers['content-length']}`);
    res.end('{}');
  });
  const options: http.RequestOptions[] = [];
  const request = http.request;
  // No machine holds the tunnel address, so the connection is the stand-in's; the rest of the
  // request is what `node:http` was given.
  vi.spyOn(http, 'request').mockImplementation(((
    asked: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) => {
    options.push(asked);
    return request(
      {
        ...asked,
        agent: undefined,
        createConnection: () => net.connect(Number(new URL(standIn.origin).port), '127.0.0.1'),
      },
      callback,
    );
  }) as typeof http.request);

  const response = await send(
    'http://[fd00::1]:8100/command',
    { method: 'POST', body: 'tap' },
    { coreDeviceTunnel: true },
  );

  expect(response.status).toBe(200);
  expect(options).toMatchObject([{ host: 'fd00::1', port: '8100', path: '/command' }]);
  expect(options[0]!.agent).toBe(await loadDirectHttpAgent());
  expect(seen).toEqual(['POST /command [fd00::1]:8100 3']);
});
