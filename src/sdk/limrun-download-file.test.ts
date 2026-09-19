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
