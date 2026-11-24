import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '@agent-device/test-kit';
import { downloadLimrunFile } from './download-file.ts';

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
    instance: { apiUrl: url, token: 'instance-token' },
    destinationPath,
    timeoutMs: 5_000,
  });

  expect(authorization).toBe('Bearer instance-token');
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('ftypisom-payload');
});

test.skipIf(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))(
  'bypasses the environment proxy only for authenticated loopback HTTP',
  async () => {
    const originAuthorization: Array<string | undefined> = [];
    const proxyAuthorization: Array<string | undefined> = [];
    const url = await serve((request, response) => {
      originAuthorization.push(request.headers.authorization);
      response.end('instance payload');
    });
    const proxyUrl = await serve((request, response) => {
      proxyAuthorization.push(request.headers.authorization);
      response.end('proxy payload');
    });
    const dir = await mkdtempForTest('limrun-download-');
    const authenticatedPath = path.join(dir, 'authenticated.mp4');
    const publicPath = path.join(dir, 'public.mp4');

    await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
          import { downloadLimrunFile } from './download-file.ts';
          const [url, authenticatedPath, publicPath] = process.argv.slice(1);
          await downloadLimrunFile({
            url,
            instance: { apiUrl: url, token: 'fixture-token' },
            destinationPath: authenticatedPath,
            timeoutMs: 5000,
          });
          await downloadLimrunFile({ url, destinationPath: publicPath, timeoutMs: 5000 });
        `,
        url,
        authenticatedPath,
        publicPath,
      ],
      {
        cwd: import.meta.dirname,
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: new URL(proxyUrl).origin,
          http_proxy: new URL(proxyUrl).origin,
          NO_PROXY: '',
          no_proxy: '',
        },
        timeout: 10_000,
      },
    );

    expect(proxyAuthorization).toEqual([undefined]);
    expect(originAuthorization).toEqual(['Bearer fixture-token']);
    expect(fs.readFileSync(authenticatedPath, 'utf8')).toBe('instance payload');
    expect(fs.readFileSync(publicPath, 'utf8')).toBe('proxy payload');
  },
);

test('accepts localhost. over HTTP only when the exact origin matches', async () => {
  const requests: Array<string | undefined> = [];
  const url = new URL(
    await serve((request, response) => {
      requests.push(request.headers.authorization);
      response.end('instance payload');
    }),
  );
  url.hostname = 'localhost.';
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  const options = { url: url.href, destinationPath, timeoutMs: 5_000 };

  await expect(
    downloadLimrunFile({
      ...options,
      instance: { apiUrl: `http://localhost:${url.port}`, token: 'fixture-token' },
    }),
  ).rejects.toMatchObject({ details: { reason: 'limrun_download_endpoint_blocked' } });
  expect(requests).toEqual([]);

  await downloadLimrunFile({
    ...options,
    instance: { apiUrl: url.origin, token: 'fixture-token' },
  });
  expect(requests).toEqual(['Bearer fixture-token']);
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('instance payload');
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
    instance: { apiUrl: url, token: 'fixture-token' },
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
  const url = await serve((_request, response) => {
    response.writeHead(500);
    response.end(`upstream rejected ${token} for this transfer`);
  });
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
  expect(details).toEqual({ reason: 'limrun_download_failed', transport: 'invalid-request' });
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

test('rejects a recording URL on a different origin before making a request', async () => {
  const traffic = vi.fn();
  const url = await serve((request, response) => {
    traffic(request);
    response.end();
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  await expect(
    downloadLimrunFile({
      url,
      instance: { apiUrl: 'https://instance.example', token: 'test-token' },
      destinationPath,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ details: { reason: 'limrun_download_endpoint_blocked' } });
  expect(traffic).not.toHaveBeenCalled();
});

test('refuses the first redirect of an authenticated download while public downloads follow it', async () => {
  const traffic = vi.fn();
  const redirect = await serve((request, response) => {
    traffic(request.headers.authorization);
    response.end('redirected payload');
  });
  const url = await serve((_request, response) => {
    response.writeHead(307, { location: redirect }).end();
  });
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  await expect(
    downloadLimrunFile({
      url,
      instance: { apiUrl: url, token: 'test-token' },
      destinationPath,
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ details: { reason: 'limrun_download_failed' } });
  expect(traffic).not.toHaveBeenCalled();
  expect(fs.existsSync(destinationPath)).toBe(false);

  await downloadLimrunFile({ url, destinationPath, timeoutMs: 5_000 });
  expect(traffic).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(fs.readFileSync(destinationPath, 'utf8')).toBe('redirected payload');
});

test('rejects an authenticated plaintext download to a non-loopback instance', async () => {
  const destinationPath = path.join(await mkdtempForTest('limrun-download-'), 'clip.mp4');
  const request = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(
      downloadLimrunFile({
        url: 'http://instance.example/recording',
        instance: { apiUrl: 'http://instance.example', token: 'test-token' },
        destinationPath,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'limrun_download_endpoint_blocked' } });
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});
