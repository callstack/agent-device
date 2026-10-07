import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { resolveGitHubActionsArtifactSource } from './github-actions-artifact-source.ts';
import { downloadInstallSource } from './install-source-download.ts';
import * as networkTransport from './install-source-network-transport.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const ARCHIVE_URL = 'https://api.github.com/repos/acme/mobile/actions/artifacts/42/zip';

function jsonResponse(
  statusCode: number,
  body: unknown,
): networkTransport.InstallSourceNetworkResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(JSON.stringify(body))]),
    close: async () => {},
  };
}

function binaryResponse(
  statusCode: number,
  body: Buffer,
  headers: Record<string, string> = {},
): networkTransport.InstallSourceNetworkResponse {
  return { statusCode, headers, body: Readable.from([body]), close: async () => {} };
}

function publicDns() {
  return vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '140.82.112.6', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
}

function refusalReason(error: unknown): unknown {
  return error instanceof AppError ? error.details?.reason : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const signal = new AbortController().signal;

test('an artifact is refused without a daemon token, before any request', async () => {
  const request = vi.spyOn(networkTransport, 'requestApprovedUrl');

  await assert.rejects(
    resolveGitHubActionsArtifactSource(
      { kind: 'github-actions-artifact', owner: 'acme', repo: 'mobile', artifactName: 'ios-sim' },
      { token: undefined, signal },
    ),
    (error) => refusalReason(error) === 'github-token-missing',
  );
  assert.equal(request.mock.calls.length, 0);
});

test('an artifact named without a run resolves to its newest archive, authorized by the daemon token', async () => {
  publicDns();
  const request = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockResolvedValueOnce(
      jsonResponse(200, { artifacts: [{ archive_download_url: ARCHIVE_URL, expired: false }] }),
    );

  const resolved = await resolveGitHubActionsArtifactSource(
    { kind: 'github-actions-artifact', owner: 'acme', repo: 'mobile', artifactName: 'ios sim' },
    { token: 'ghs_daemon', signal },
  );

  const call = request.mock.calls[0]![0];
  assert.equal(
    call.url.toString(),
    'https://api.github.com/repos/acme/mobile/actions/artifacts?name=ios%20sim&per_page=1',
  );
  assert.equal(call.headers.authorization, 'Bearer ghs_daemon');
  assert.equal(resolved.url, ARCHIVE_URL);
  assert.equal(resolved.headers.authorization, 'Bearer ghs_daemon');
});

test('a missing and an expired artifact are refused with typed reasons', async () => {
  publicDns();
  vi.spyOn(networkTransport, 'requestApprovedUrl')
    .mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' }))
    .mockResolvedValueOnce(jsonResponse(200, { archive_download_url: ARCHIVE_URL, expired: true }));
  const source = {
    kind: 'github-actions-artifact' as const,
    owner: 'acme',
    repo: 'mobile',
    artifactId: 42,
  };

  await assert.rejects(
    resolveGitHubActionsArtifactSource(source, { token: 'ghs_daemon', signal }),
    (error) => refusalReason(error) === 'github-artifact-not-found',
  );
  await assert.rejects(
    resolveGitHubActionsArtifactSource(source, { token: 'ghs_daemon', signal }),
    (error) => refusalReason(error) === 'github-artifact-expired',
  );
});

test('the archive download drops the daemon token at the storage redirect', async () => {
  publicDns();
  const tempDir = await mkdtempForTest('agent-device-github-artifact-');
  const request = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockResolvedValueOnce(
      jsonResponse(200, { artifacts: [{ archive_download_url: ARCHIVE_URL, expired: false }] }),
    )
    .mockResolvedValueOnce(
      binaryResponse(302, Buffer.alloc(0), {
        location: 'https://productionresults.blob.core.windows.net/artifact.zip?sig=x',
      }),
    )
    .mockResolvedValueOnce(binaryResponse(200, Buffer.from('zip')));

  const resolved = await resolveGitHubActionsArtifactSource(
    {
      kind: 'github-actions-artifact',
      owner: 'acme',
      repo: 'mobile',
      runId: 7,
      artifactName: 'ios',
    },
    { token: 'ghs_daemon', signal },
  );
  const archive = await downloadInstallSource({ tempDir, ...resolved, signal });

  assert.equal(await fs.readFile(archive, 'utf8'), 'zip');
  assert.equal(request.mock.calls[1]![0].headers.authorization, 'Bearer ghs_daemon');
  assert.equal(request.mock.calls[2]![0].headers.authorization, undefined);
});
