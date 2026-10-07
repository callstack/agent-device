import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  resolveGitHubActionsArtifactSource,
  type GitHubArtifactResolutionOptions,
} from './github-actions-artifact-source.ts';
import { downloadInstallSource } from './install-source-download.ts';
import * as networkTransport from './install-source-network-transport.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const ARCHIVE_URL = 'https://api.github.com/repos/acme/mobile/actions/artifacts/42/zip';
const OWN_RUN = { repository_id: 1, head_repository_id: 1 };
const FORK_RUN = { repository_id: 1, head_repository_id: 2 };

function response(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): networkTransport.InstallSourceNetworkResponse {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return { statusCode, headers, body: Readable.from([bytes]), close: async () => {} };
}

function network(...responses: networkTransport.InstallSourceNetworkResponse[]) {
  vi.spyOn(dns, 'lookup').mockImplementation(
    async () =>
      [{ address: '140.82.112.6', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
  );
  const request = vi.spyOn(networkTransport, 'requestApprovedUrl');
  for (const next of responses) request.mockResolvedValueOnce(next);
  return request;
}

function options(overrides: Partial<GitHubArtifactResolutionOptions> = {}) {
  return {
    token: 'ghs_daemon',
    tokenSource: 'AGENT_DEVICE_GITHUB_TOKEN',
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function reasonOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error.details?.reason ?? error.message;
  }
  assert.fail('expected a refusal');
}

const byName = (artifactName: string) =>
  ({ kind: 'github-actions-artifact', owner: 'acme', repo: 'mobile', artifactName }) as const;
const byId = {
  kind: 'github-actions-artifact',
  owner: 'acme',
  repo: 'mobile',
  artifactId: 42,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

test('a name picks the newest live build of the repository itself, never a fork pull request', async () => {
  const request = network(
    response(200, {
      artifacts: [
        { archive_download_url: ARCHIVE_URL.replace('42', '99'), workflow_run: FORK_RUN },
        {
          archive_download_url: ARCHIVE_URL.replace('42', '43'),
          expired: true,
          workflow_run: OWN_RUN,
        },
        { archive_download_url: ARCHIVE_URL, workflow_run: OWN_RUN },
      ],
    }),
  );

  const resolved = await resolveGitHubActionsArtifactSource(byName('ios sim'), options());

  const call = request.mock.calls[0]![0];
  assert.equal(
    call.url.toString(),
    'https://api.github.com/repos/acme/mobile/actions/artifacts?name=ios%20sim&per_page=100',
  );
  assert.equal(call.headers.authorization, 'Bearer ghs_daemon');
  assert.equal(resolved.url, ARCHIVE_URL);
});

test('refusals are typed, and the ones that need no request reach no network', async () => {
  const request = network();
  const local: Array<[unknown, Promise<unknown>]> = [
    [
      'github-token-missing',
      resolveGitHubActionsArtifactSource(byId, options({ token: undefined })),
    ],
    [
      'github-repository-not-allowed',
      resolveGitHubActionsArtifactSource(byId, options({ allowedRepositories: ['acme/other'] })),
    ],
    [
      'Invalid GitHub repository name: ..',
      resolveGitHubActionsArtifactSource({ ...byId, owner: '..' }, options()),
    ],
  ];
  for (const [reason, run] of local) assert.equal(await reasonOf(run), reason);
  assert.equal(request.mock.calls.length, 0);

  network(
    response(404, { message: 'Not Found' }),
    response(200, { archive_download_url: ARCHIVE_URL, expired: true }),
    response(200, { archive_download_url: 'https://evil.example/zip' }),
    response(401, { message: 'Bad credentials' }),
    response(200, Buffer.from('<html>portal</html>')),
  );
  for (const reason of [
    'github-artifact-not-found',
    'github-artifact-expired',
    'github-artifact-url-unexpected',
    'github-token-rejected',
    'github-api-invalid-response',
  ]) {
    assert.equal(await reasonOf(resolveGitHubActionsArtifactSource(byId, options())), reason);
  }
});

test('the archive download drops the daemon token at the storage redirect', async () => {
  const tempDir = await mkdtempForTest('agent-device-github-artifact-');
  try {
    const request = network(
      response(200, { artifacts: [{ archive_download_url: ARCHIVE_URL }] }),
      response(302, Buffer.alloc(0), {
        location: 'https://productionresults.blob.core.windows.net/artifact.zip?sig=x',
      }),
      response(200, Buffer.from('zip')),
    );

    const resolved = await resolveGitHubActionsArtifactSource(
      { ...byName('ios'), runId: 7 },
      options(),
    );
    const archive = await downloadInstallSource({ tempDir, ...resolved, signal: options().signal });

    assert.equal(await fs.readFile(archive, 'utf8'), 'zip');
    assert.match(request.mock.calls[0]![0].url.pathname, /\/runs\/7\/artifacts$/);
    assert.equal(request.mock.calls[1]![0].headers.authorization, 'Bearer ghs_daemon');
    assert.equal(request.mock.calls[2]![0].headers.authorization, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
