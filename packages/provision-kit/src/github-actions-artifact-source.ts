import type { DaemonInstallSource } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { approveDownloadSourceUrl } from './install-source-network.ts';
import * as networkTransport from './install-source-network-transport.ts';

type GitHubActionsArtifactSource = Extract<
  DaemonInstallSource,
  { kind: 'github-actions-artifact' }
>;

export type ResolvedGitHubActionsArtifact = Readonly<{
  kind: 'url';
  url: string;
  headers: Record<string, string>;
}>;

type GitHubArtifact = { archive_download_url?: unknown; expired?: unknown };

const GITHUB_API_ORIGIN = 'https://api.github.com';
const MAX_API_RESPONSE_BYTES = 1024 * 1024;

/**
 * Turns a GitHub Actions artifact into the download its archive URL serves, authorized with the
 * daemon host's own token. The token is never part of a request: a remote client names the
 * artifact, and the daemon decides whether it can read it. The archive URL redirects to storage on
 * another origin, where the downloader drops the Authorization header.
 */
export async function resolveGitHubActionsArtifactSource(
  source: GitHubActionsArtifactSource,
  options: { token: string | undefined; signal: AbortSignal },
): Promise<ResolvedGitHubActionsArtifact> {
  const token = options.token?.trim();
  if (!token) {
    throw artifactError(
      'github-token-missing',
      'Installing a GitHub Actions artifact needs a GitHub token on the daemon host.',
      'Set AGENT_DEVICE_GITHUB_TOKEN for the daemon process and restart a daemon that is already running; clients never send a GitHub token.',
    );
  }
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const artifact = await findArtifact(source, headers, options.signal);
  if (!artifact || typeof artifact.archive_download_url !== 'string') {
    throw artifactError(
      'github-artifact-not-found',
      `GitHub Actions artifact was not found in ${source.owner}/${source.repo}.`,
      'Check the artifact name or id and that the daemon token can read the repository.',
    );
  }
  if (artifact.expired === true) {
    throw artifactError(
      'github-artifact-expired',
      `GitHub Actions artifact in ${source.owner}/${source.repo} has expired.`,
      'Re-run the workflow that produces it, or install from a newer run.',
    );
  }
  return { kind: 'url', url: artifact.archive_download_url, headers };
}

async function findArtifact(
  source: GitHubActionsArtifactSource,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<GitHubArtifact | undefined> {
  const repo = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/actions`;
  if ('artifactId' in source) {
    return await requestJson<GitHubArtifact>(
      `${repo}/artifacts/${source.artifactId}`,
      headers,
      signal,
    );
  }
  const query = `artifacts?name=${encodeURIComponent(source.artifactName)}&per_page=1`;
  const listUrl = 'runId' in source ? `${repo}/runs/${source.runId}/${query}` : `${repo}/${query}`;
  const list = await requestJson<{ artifacts?: GitHubArtifact[] }>(listUrl, headers, signal);
  return list?.artifacts?.[0];
}

async function requestJson<T>(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<T | undefined> {
  const parsedUrl = new URL(url);
  const approved = await approveDownloadSourceUrl(parsedUrl, signal);
  const response = await networkTransport.requestApprovedUrl({
    url: parsedUrl,
    approvedAddress: approved.address,
    family: approved.family,
    headers: { ...headers, 'user-agent': 'agent-device', 'accept-encoding': 'identity' },
    signal,
  });
  try {
    if (response.statusCode === 404) return undefined;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new AppError(
        'COMMAND_FAILED',
        `GitHub API refused the artifact lookup: ${response.statusCode}`,
        {
          status: response.statusCode,
          hint: 'Check that AGENT_DEVICE_GITHUB_TOKEN can read Actions artifacts in this repository.',
        },
      );
    }
    return JSON.parse(await readBounded(response.body)) as T;
  } finally {
    await response.close();
  }
}

async function readBounded(body: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_API_RESPONSE_BYTES) {
      throw new AppError('COMMAND_FAILED', 'GitHub API response exceeded the size limit.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function artifactError(reason: string, message: string, hint: string): AppError {
  return new AppError('COMMAND_FAILED', message, { reason, hint });
}
