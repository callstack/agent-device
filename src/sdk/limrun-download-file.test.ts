import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTest } from '../__tests__/test-utils/tmp-dir.ts';
import { downloadLimrunFile } from './limrun-download-file.ts';

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
