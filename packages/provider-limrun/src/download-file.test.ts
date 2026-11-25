import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '@agent-device/test-kit';
import { downloadLimrunFile } from './download-file.ts';

const servers: Array<http.Server | https.Server> = [];

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

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/files?name=recording.mp4`;
}

test('streams an authenticated HTTPS download and refuses the first redirect', async () => {
  const fixture = new URL(
    '../../../test/integration/provider-scenarios/fixtures/',
    import.meta.url,
  );
  const certPath = new URL('localhost-cert.pem', fixture);
  const authorizations: Array<string | undefined> = [];
  const redirected = vi.fn();
  const server = https.createServer(
    {
      key: fs.readFileSync(new URL('localhost-key.pem', fixture)),
      cert: fs.readFileSync(certPath),
    },
    (request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.url === '/redirect') {
        response.writeHead(307, { location: '/target' }).end();
        return;
      }
      if (request.url === '/target') redirected();
      response.end('ftypisom-payload');
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  const entry = new URL('./download-file.ts', import.meta.url).href;
  await promisify(execFile)(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        const [entry, origin, destinationPath] = process.argv.slice(1);
        const { downloadLimrunFile } = await import(entry);
        const options = {
          instance: { apiUrl: origin, token: 'fixture-token' },
          destinationPath,
          timeoutMs: 5000
        };
        await downloadLimrunFile({ ...options, url: origin + '/file' });
        assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'ftypisom-payload');
        await assert.rejects(downloadLimrunFile({ ...options, url: origin + '/redirect' }), {
          details: { reason: 'limrun_download_failed', transport: 'request-failed' }
        });
        assert.equal(fs.existsSync(destinationPath), false);
      `,
      entry,
      origin,
      destinationPath,
    ],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: fileURLToPath(certPath) } },
  );
  expect(authorizations).toEqual(['Bearer fixture-token', 'Bearer fixture-token']);
  expect(redirected).not.toHaveBeenCalled();
});

test('a non-2xx answer is a typed failure carrying the status and no file is left behind', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(404);
    response.end('no active recording');
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { statusCode: 404, reason: 'limrun_download_http_error' },
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

  const failure = downloadLimrunFile({
    url,
    destinationPath,
    timeoutMs: 150,
  });

  await expect(failure).rejects.toBeInstanceOf(AppError);
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun download timed out',
    details: { timeoutMs: 150 },
  });
  expect(fs.existsSync(destinationPath)).toBe(false);
});

test('a non-2xx answer whose body stalls is answered by its status without waiting for the body', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(503);
    response.write('upstr');
    // Never end: nothing here reads the body, so the status answers at once.
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await expect(
    downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { statusCode: 503, reason: 'limrun_download_http_error' },
  });
});

// The download route is authenticated with the instance token, and an error body is the peer's own text,
// which can echo that token as a bare value. So no body text is published at all: the typed status and
// reason answer for the failure, and the token cannot survive a clipping or a short length.
test('an HTTP failure publishes its status and reason, and no peer body text at all', async () => {
  const token = 'abc123';
  const url = 'https://instance.example/recording';
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(`upstream rejected ${token} for this transfer`, { status: 500 }),
    );
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  let failure: unknown;
  await downloadLimrunFile({
    url,
    instance: { apiUrl: url, token },
    destinationPath,
    timeoutMs: 5_000,
  }).catch((error: AppError) => {
    failure = error;
  });

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details).toEqual({
    statusCode: 500,
    reason: 'limrun_download_http_error',
  });
  expect(JSON.stringify((failure as AppError).details)).not.toMatch(token);
  request.mockRestore();
});

// A malformed URL is the failure an attached instance can cause: it answers with its bare bearer token
// as the download URL. Neither the URL nor fetch's message about it may be published.
test('a malformed download URL publishes neither the URL nor the transport message', async () => {
  const token = 'liminst_9b74c9897bac770ffc029102a200c5de';
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  let failure: unknown;
  await downloadLimrunFile({
    url: token,
    instance: { apiUrl: 'https://instance.example', token },
    destinationPath,
    timeoutMs: 5_000,
  }).catch((error: AppError) => {
    failure = error;
  });

  expect(failure).toBeInstanceOf(AppError);
  const details = (failure as AppError).details ?? {};
  expect(details).toEqual({ reason: 'limrun_download_failed', transport: 'request-failed' });
  expect(JSON.stringify(details)).not.toMatch(token);
  expect(JSON.stringify((failure as AppError).cause ?? '')).not.toMatch(token);
});

test('a failed retry removes the file an earlier attempt left at the destination', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(500);
    response.end('recorder gone');
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  fs.writeFileSync(destinationPath, 'earlier attempt');

  await expect(
    downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 }),
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

  const failure = downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 });

  await expect(failure).rejects.toBeInstanceOf(AppError);
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun download failed',
    details: { reason: 'limrun_download_failed', transport: 'EEXIST' },
  });
  expect(requests).toEqual([]);
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

test('rejects a recording URL on a different HTTPS origin before making a request', async () => {
  const request = vi.spyOn(globalThis, 'fetch');
  try {
    const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
    await expect(
      downloadLimrunFile({
        url: 'https://files.example/recording',
        instance: { apiUrl: 'https://instance.example', token: 'test-token' },
        destinationPath,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'limrun_download_endpoint_blocked' } });
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});

test('follows redirects for public downloads without a bearer', async () => {
  const traffic = vi.fn();
  const redirect = await serve((request, response) => {
    traffic(request.headers.authorization);
    response.end('redirected payload');
  });
  const url = await serve((_request, response) => {
    response.writeHead(307, { location: redirect }).end();
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');

  await downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 });
  expect(traffic).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('redirected payload');
});

test.each(['http://127.0.0.1', 'http://localhost.', 'http://instance.example'])(
  'rejects an authenticated plaintext download from %s before fetch',
  async (origin) => {
    const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
    const request = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        downloadLimrunFile({
          url: origin + '/recording',
          instance: { apiUrl: origin, token: 'test-token' },
          destinationPath,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({
        details: {
          reason: 'limrun_download_endpoint_blocked',
          hint: expect.stringContaining('HTTPS'),
        },
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  },
);
