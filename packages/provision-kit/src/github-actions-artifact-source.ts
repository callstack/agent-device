import { pipeline } from 'node:stream/promises';
import { createByteLimitStream } from '@agent-device/host-kit/archive';
import type { DaemonInstallSource } from '@agent-device/kernel/contracts';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { assertGitHubRepositoryNamePart } from './install-source-config.ts';
import { requestApprovedSource } from './install-source-download.ts';

type GitHubActionsArtifactSource = Extract<
  DaemonInstallSource,
  { kind: 'github-actions-artifact' }
>;

export type ResolvedGitHubActionsArtifact = Readonly<{
  kind: 'url';
  url: string;
  headers: Record<string, string>;
}>;

export type GitHubArtifactResolutionOptions = Readonly<{
  token: string | undefined;
  /** Where the operator sets the token, named in refusal hints. */
  tokenSource: string;
  /** `owner/repo` names the token may be used for; every repository when absent. */
  allowedRepositories?: readonly string[];
  /** Where the operator sets the allowed repositories, named in refusal hints. */
  allowedRepositoriesSource?: string;
  signal: AbortSignal;
}>;

type GitHubArtifact = {
  archive_download_url?: unknown;
  expired?: unknown;
  workflow_run?: { repository_id?: unknown; head_repository_id?: unknown };
};

const GITHUB_API_ORIGIN = 'https://api.github.com';
const LOOKUP_TIMEOUT_MS = 30_000;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_API_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/**
 * Turns a GitHub Actions artifact into the download its archive URL serves, authorized with the
 * daemon host's own token. A remote client only names the artifact; it never sends a token. The
 * archive URL must stay on the GitHub API under the named repository, and its redirect to storage
 * on another origin drops the Authorization header in the downloader.
 */
export async function resolveGitHubActionsArtifactSource(
  source: GitHubActionsArtifactSource,
  options: GitHubArtifactResolutionOptions,
): Promise<ResolvedGitHubActionsArtifact> {
  const repository = assertRepository(source, options);
  const token = options.token?.trim();
  if (!token) {
    throw artifactError(
      'github-token-missing',
      'Installing a GitHub Actions artifact needs a GitHub token on the daemon host.',
      {
        hint: `Set ${options.tokenSource} for the daemon process; clients never send a GitHub token.`,
      },
    );
  }
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, timeout]);
  let artifact: GitHubArtifact | undefined;
  try {
    artifact = await findArtifact(source, repository, headers, signal, options.tokenSource);
  } catch (error) {
    if (options.signal.aborted) throw createRequestCanceledError(undefined, error);
    if (!timeout.aborted) throw error;
    throw artifactError(
      'github-api-timeout',
      `GitHub API lookup timed out after ${LOOKUP_TIMEOUT_MS}ms.`,
      {},
      error,
    );
  }
  if (!artifact) {
    throw artifactError(
      'github-artifact-not-found',
      `GitHub Actions artifact was not found in ${repository}.`,
      { hint: 'Check the artifact name or id, and that the daemon token can read the repository.' },
    );
  }
  if (artifact.expired === true) {
    throw artifactError(
      'github-artifact-expired',
      `GitHub Actions artifact in ${repository} has expired.`,
      { hint: 'Re-run the workflow that produces it, or install from a newer run.' },
    );
  }
  return { kind: 'url', url: archiveUrl(artifact, repository), headers };
}

function assertRepository(
  source: GitHubActionsArtifactSource,
  options: GitHubArtifactResolutionOptions,
): string {
  assertGitHubRepositoryNamePart(source.owner);
  assertGitHubRepositoryNamePart(source.repo);
  const repository = `${source.owner}/${source.repo}`;
  const allowed = options.allowedRepositories?.map((entry) => entry.toLowerCase());
  if (allowed && !allowed.includes(repository.toLowerCase())) {
    throw artifactError(
      'github-repository-not-allowed',
      `The daemon does not read artifacts from ${repository}.`,
      {
        hint: `Add the repository to ${options.allowedRepositoriesSource ?? 'the allowed repositories'} on the daemon host.`,
      },
    );
  }
  return repository;
}

/**
 * An artifact id names one build. A name alone picks the newest live artifact from a run in this
 * repository itself: a pull request from a fork uploads into the same list, and its build must
 * never stand in for the repository's own.
 */
async function findArtifact(
  source: GitHubActionsArtifactSource,
  repository: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  tokenSource: string,
): Promise<GitHubArtifact | undefined> {
  const actions = `${GITHUB_API_ORIGIN}/repos/${repository}/actions`;
  const lookup = <T>(url: string) => requestJson<T>(url, headers, signal, tokenSource);
  const artifactId = 'artifactId' in source ? source.artifactId : undefined;
  if (artifactId !== undefined)
    return await lookup<GitHubArtifact>(`${actions}/artifacts/${artifactId}`);
  const artifactName = 'artifactName' in source ? source.artifactName : '';
  const runId = 'runId' in source ? source.runId : undefined;
  const byRun = runId !== undefined;
  const query = `artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`;
  const list = await lookup<{ artifacts?: GitHubArtifact[] }>(
    byRun ? `${actions}/runs/${runId}/${query}` : `${actions}/${query}`,
  );
  const candidates = (list?.artifacts ?? []).filter((item) => byRun || isOwnRepositoryRun(item));
  return candidates.find((item) => item.expired !== true) ?? candidates[0];
}

function isOwnRepositoryRun(artifact: GitHubArtifact): boolean {
  const run = artifact.workflow_run;
  return run?.repository_id !== undefined && run.head_repository_id === run.repository_id;
}

function archiveUrl(artifact: GitHubArtifact, repository: string): string {
  const raw =
    typeof artifact.archive_download_url === 'string' ? artifact.archive_download_url : '';
  const url = URL.parse(raw);
  const prefix = `/repos/${repository}/actions/artifacts/`;
  if (url?.origin !== GITHUB_API_ORIGIN || !url.pathname.startsWith(prefix)) {
    throw artifactError(
      'github-artifact-url-unexpected',
      'GitHub returned an archive URL outside the repository.',
      {},
    );
  }
  return url.toString();
}

async function requestJson<T>(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  tokenSource: string,
): Promise<T | undefined> {
  let current = new URL(url);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestApprovedSource(
      current,
      { ...headers, 'user-agent': 'agent-device' },
      signal,
    );
    try {
      const status = response.statusCode;
      const next = apiRedirect(status, response.headers.location, current);
      if (next && redirects < MAX_API_REDIRECTS) {
        current = next;
        continue;
      }
      if (status === 404) return undefined;
      if (status < 200 || status >= 300) throw apiStatusError(status, tokenSource);
      return parseJson<T>(await readBounded(response.body));
    } finally {
      await response.close();
    }
  }
}

/** Follows a redirect only while it stays on the GitHub API, which the token is scoped to. */
function apiRedirect(status: number, location: unknown, current: URL): URL | undefined {
  if (!REDIRECT_STATUSES.has(status) || typeof location !== 'string') return undefined;
  const next = URL.parse(location, current);
  return next?.origin === GITHUB_API_ORIGIN ? next : undefined;
}

function apiStatusError(status: number, tokenSource: string): AppError {
  if (status === 401) {
    return artifactError('github-token-rejected', 'GitHub rejected the daemon token.', {
      status,
      hint: `Replace ${tokenSource} with a valid token.`,
    });
  }
  const refused = status === 403 || status === 429;
  return artifactError(
    refused ? 'github-api-refused' : 'github-api-error',
    `GitHub API answered the artifact lookup with ${status}.`,
    {
      status,
      hint: refused
        ? `The token may lack Actions read access to the repository or hit a rate limit; check ${tokenSource}.`
        : 'Retry later; GitHub did not answer the lookup.',
    },
  );
}

async function readBounded(body: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  await pipeline(
    body,
    createByteLimitStream({
      maxBytes: MAX_API_RESPONSE_BYTES,
      createLimitError: () =>
        artifactError('github-api-invalid-response', 'GitHub API response is too large.', {}),
    }),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk);
    },
  );
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw artifactError(
      'github-api-invalid-response',
      'GitHub API answered with a body that is not JSON.',
      {},
      error,
    );
  }
}

function artifactError(
  reason: string,
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): AppError {
  return new AppError('COMMAND_FAILED', message, { reason, ...details }, cause);
}
