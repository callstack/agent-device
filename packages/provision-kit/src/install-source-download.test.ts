import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test, vi } from 'vitest';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';
import { downloadInstallSource } from './install-source-download.ts';
import * as networkTransport from './install-source-network-transport.ts';

test('download redirects revalidate destinations and strip sensitive cross-origin headers', async () => {
  const tempRoot = await mkdtempForTest('agent-device-download-redirect-');
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const requestMock = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockResolvedValueOnce(
      response(302, Buffer.alloc(0), { location: 'https://cdn.example.net/app.apk' }),
    )
    .mockResolvedValueOnce(response(200, Buffer.from('apk')));
  try {
    const result = await downloadInstallSource({
      tempDir: tempRoot,
      url: 'https://example.com/start',
      headers: {
        authorization: 'secret',
        accept: 'application/octet-stream',
        connection: 'x-private',
        'x-private': 'remove-me',
        'user-agent': 'agent-device-test',
      },
      signal: new AbortController().signal,
    });
    assert.equal(await fs.readFile(result, 'utf8'), 'apk');
    assert.equal(lookup.mock.calls.length, 2);
    const first = requestMock.mock.calls[0]![0];
    const second = requestMock.mock.calls[1]![0];
    assert.equal(first.headers['accept-encoding'], 'identity');
    assert.equal(second.headers.authorization, undefined);
    assert.equal(second.headers['x-private'], undefined);
    assert.equal(second.headers.accept, 'application/octet-stream');
  } finally {
    requestMock.mockRestore();
    lookup.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('download errors do not disclose URL credentials or query values', async () => {
  const tempRoot = await mkdtempForTest('agent-device-download-redaction-');
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const requestMock = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockResolvedValue(response(503));
  try {
    const error = await downloadInstallSource({
      tempDir: tempRoot,
      url: 'https://private-user:private-pass@example.com/app?token=private-query',
      headers: { authorization: 'private-header' },
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    assert.match((error as Error).message, /credentials are not allowed/i);
    const serialized = JSON.stringify(error);
    for (const secret of ['private-user', 'private-pass', 'private-query', 'private-header']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  } finally {
    requestMock.mockRestore();
    lookup.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('download identifies the daemon as the requester and preserves the network cause', async () => {
  const tempRoot = await mkdtempForTest('agent-device-download-network-error-');
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const transportError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
    code: 'ECONNREFUSED',
  });
  const requestMock = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockRejectedValue(transportError);
  try {
    const error = await downloadInstallSource({
      tempDir: tempRoot,
      url: 'https://example.com/app.apk',
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);

    assert.ok(error instanceof Error);
    assert.equal(error.message, 'The daemon failed to fetch the app source');
    assert.equal((error as { cause?: unknown }).cause, transportError);
  } finally {
    requestMock.mockRestore();
    lookup.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('download rejects non-identity content encoding and malformed lengths', async () => {
  const tempRoot = await mkdtempForTest('agent-device-download-metadata-');
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  const requestMock = vi.spyOn(networkTransport, 'requestApprovedUrl');
  try {
    requestMock.mockResolvedValueOnce(
      response(200, Buffer.from('body'), { 'content-encoding': 'gzip' }),
    );
    await assert.rejects(
      downloadInstallSource({
        tempDir: tempRoot,
        url: 'https://example.com/app',
        signal: new AbortController().signal,
      }),
      /content encoding/i,
    );
    requestMock.mockResolvedValueOnce(
      response(200, Buffer.from('body'), { 'content-length': '+4' }),
    );
    await assert.rejects(
      downloadInstallSource({
        tempDir: tempRoot,
        url: 'https://example.com/app',
        signal: new AbortController().signal,
      }),
      /content-length/i,
    );
  } finally {
    requestMock.mockRestore();
    lookup.mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function response(
  statusCode: number,
  body: Buffer = Buffer.alloc(0),
  headers: Record<string, string> = {},
): networkTransport.InstallSourceNetworkResponse {
  return {
    statusCode,
    headers,
    body: Readable.from(body),
    close: async () => {},
  };
}
