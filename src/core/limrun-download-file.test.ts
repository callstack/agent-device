import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError, createRequestCanceledError, normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '@agent-device/test-kit';
import { downloadLimrunFile } from './limrun-download-file.ts';

const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/files?name=recording.mp4`;
}

test('streams the served file to disk with the bearer token the caller supplied', async () => {
  let authorization: string | undefined;
  const url = await serve((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.end(Buffer.from('ftypisom-payload'));
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await downloadLimrunFile({
    url,
    headers: { Authorization: 'Bearer instance-token' },
    destinationPath,
    timeoutMs: 5_000,
  });

  expect(authorization).toBe('Bearer instance-token');
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('ftypisom-payload');
});

test('a non-2xx answer is a typed failure carrying the status and no file is left behind', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(404);
    response.end('no active recording');
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { statusCode: 404, body: 'no active recording' },
  });
  expect(fs.existsSync(destinationPath)).toBe(false);
});

test('a stalled transfer ends at the deadline as a typed timeout and removes the partial file', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'video/mp4' });
    response.write('partial');
    // Never end: the client deadline has to cut the transfer.
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  const failure = downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 150 });

  await expect(failure).rejects.toBeInstanceOf(AppError);
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun download timed out',
    details: { timeoutMs: 150 },
  });
  expect(fs.existsSync(destinationPath)).toBe(false);
});

test('a non-2xx answer whose body stalls ends at the deadline as the typed timeout', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(503);
    response.write('upstr');
    // Never end: the error body stalls like a transfer can.
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 150 }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun download timed out',
    details: { timeoutMs: 150 },
  });
});

test('a failed retry removes the file an earlier attempt left at the destination', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(500);
    response.end('recorder gone');
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  fs.writeFileSync(destinationPath, 'earlier attempt');

  await expect(
    downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { statusCode: 500 } });
  expect(fs.existsSync(destinationPath)).toBe(false);
});

test('a destination directory that cannot be created ends typed without fetching', async () => {
  const requests: string[] = [];
  const url = await serve((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200);
    response.end('payload');
  });
  const blocker = path.join(await mkdtempForTest('limrun-download-'), 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  const destinationPath = path.join(blocker, 'clip.mp4');

  const failure = downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 5_000 });

  await expect(failure).rejects.toBeInstanceOf(AppError);
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun download failed',
    details: { url },
  });
  expect(requests).toEqual([]);
});

test('an error body is read only up to the preview, without waiting for the rest', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(502);
    response.write('x'.repeat(2_048));
    // Never end: the preview must not wait for the whole body.
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { statusCode: 502, body: 'x'.repeat(500) },
  });
});

test.each(['default', 'typed', 'deadline'] as const)(
  'a %s abort keeps its failure classification and removes partial downloads',
  async (kind) => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const url = await serve((_request, response) => {
      response.writeHead(200);
      response.write('partial');
      markStarted();
    });
    const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
    const controller = new AbortController();
    const reason =
      kind === 'typed'
        ? createRequestCanceledError()
        : kind === 'deadline'
          ? new DOMException('deadline expired', 'TimeoutError')
          : undefined;
    const pending = downloadLimrunFile({
      url,
      headers: {},
      destinationPath,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    const outcome =
      kind === 'typed'
        ? expect(pending).rejects.toBe(reason)
        : kind === 'default'
          ? expect(pending).rejects.toMatchObject({
              code: 'COMMAND_FAILED',
              details: { reason: 'request_canceled' },
            })
          : expect(pending).rejects.toMatchObject({
              code: 'COMMAND_FAILED',
              message: 'Limrun download deadline expired',
              details: { reason: 'limrun_download_timeout', timeoutMs: 5000 },
            });
    await started;
    await vi.waitFor(() => expect(fs.readFileSync(destinationPath, 'utf8')).toBe('partial'));
    controller.abort(reason);
    await outcome;
    expect(fs.existsSync(destinationPath)).toBe(false);
  },
);

test('a download URL over plain http off loopback is never requested and writes nothing', async () => {
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  fs.writeFileSync(destinationPath, 'earlier download');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  await expect(
    downloadLimrunFile({
      url: 'http://limrun.invalid/files?signature=signed',
      headers: {},
      destinationPath,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ details: { reason: 'insecure_credential_transport' } });

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('earlier download');
});

test('an https redirect to another origin is followed without the caller headers', async () => {
  const sent: Array<[string, string | null]> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    sent.push([String(input), new Headers(init?.headers).get('authorization')]);
    if (sent.length > 1) return new Response('payload');
    const location = 'https://storage.example/clip?signature=signed';
    return new Response(null, { status: 302, headers: { location } });
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await downloadLimrunFile({
    url: 'https://limrun.example/files',
    headers: { Authorization: 'Bearer instance-token' },
    destinationPath,
    timeoutMs: 5_000,
  });

  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('payload');
  expect(sent).toEqual([
    ['https://limrun.example/files', 'Bearer instance-token'],
    ['https://storage.example/clip?signature=signed', null],
  ]);
});

/** A loopback server that answers `redirects` same-origin 307s before it serves the file. */
async function serveRedirectChain(redirects: number) {
  const requests: string[] = [];
  const url = await serve((request, response) => {
    requests.push(request.headers.authorization ?? '-');
    if (requests.length > redirects) return void response.end('payload');
    response.writeHead(307, { location: `/hop-${requests.length}` }).end();
  });
  return { url, requests };
}

test.each([4, 20])('a chain of %i same-origin redirects ends with the file', async (redirects) => {
  const { url, requests } = await serveRedirectChain(redirects);
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await downloadLimrunFile({
    url,
    headers: { Authorization: 'Bearer instance-token' },
    destinationPath,
    timeoutMs: 5_000,
  });

  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('payload');
  expect(requests).toEqual(Array(redirects + 1).fill('Bearer instance-token'));
});

test('a twenty-first redirect is not followed', async () => {
  const { url, requests } = await serveRedirectChain(21);
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, headers: {}, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({ details: { statusCode: 307 } });
  expect(requests).toHaveLength(21);
});

test.each([
  ['plain http', 'http://storage.example/clip?signature=target-secret'],
  ['a URL with a username', 'https://target-secret@limrun.example/clip'],
])(
  'a redirect to %s is not followed, and its failure keeps no URL, Location or body',
  async (_label, location) => {
    const cancel = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const echo = new TextEncoder().encode(`${location} Bearer instance-token`);
      const body = new ReadableStream({ start: (stream) => stream.enqueue(echo), cancel });
      return new Response(body, { status: 307, headers: { location } });
    });
    const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

    const failure = await downloadLimrunFile({
      url: 'https://limrun.example/files?signature=source-secret',
      headers: { Authorization: 'Bearer instance-token' },
      destinationPath,
      timeoutMs: 5_000,
    }).catch(normalizeError);

    expect(failure).toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'Limrun download did not follow a redirect',
      details: { statusCode: 307, reason: 'limrun_download_http_error' },
    });
    expect(JSON.stringify(failure)).not.toMatch(/secret|instance-token|\.example/);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fs.existsSync(destinationPath)).toBe(false);
  },
);
