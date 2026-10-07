import { AppError } from '@agent-device/kernel/errors';
import type { DaemonInstallSource, LocalInstallSource } from '@agent-device/kernel/contracts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { hostEnvironment } from '@agent-device/host-kit/process';
import { resolveGitHubActionsArtifactSource } from '@agent-device/provision-kit/github-actions-artifact-source';
import {
  DAEMON_GITHUB_REPOSITORIES_ENV,
  DAEMON_GITHUB_TOKEN_ENV,
  readDaemonGitHubRepositories,
  readDaemonGitHubToken,
} from '../daemon-github-token.ts';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from './artifact-tracking.ts';
import type { DaemonRequest } from './daemon-request.ts';

type GitHubActionsArtifactSource = Extract<
  DaemonInstallSource,
  { kind: 'github-actions-artifact' }
>;
type RequestedInstallSource = LocalInstallSource | GitHubActionsArtifactSource;

function assertUnsupportedInstallSource(source: never): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `install_from_source does not support ${String((source as DaemonInstallSource).kind)} sources`,
  );
}

function requireInstallSource(req: DaemonRequest): RequestedInstallSource {
  const source = req.meta?.installSource;
  if (!source) {
    throw new AppError('INVALID_ARGS', 'install_from_source requires a source payload');
  }
  switch (source.kind) {
    case 'url':
      if (!source.url || source.url.trim().length === 0) {
        throw new AppError(
          'INVALID_ARGS',
          'install_from_source url source requires a non-empty url',
        );
      }
      return source;
    case 'path':
      if (!source.path || source.path.trim().length === 0) {
        throw new AppError(
          'INVALID_ARGS',
          'install_from_source path source requires a non-empty path',
        );
      }
      return source;
    case 'github-actions-artifact':
      return source;
    default:
      assertUnsupportedInstallSource(source);
  }
}

/** Reads the request's source without touching the network; see `toDownloadableSource`. */
export function resolveInstallSource(req: DaemonRequest): {
  source: RequestedInstallSource;
  cleanup: () => void;
} {
  const source = requireInstallSource(req);
  const uploadedArtifactId = req.meta?.uploadedArtifactId;
  if (!uploadedArtifactId || source.kind !== 'path') {
    return { source, cleanup: () => {} };
  }
  return {
    source: {
      kind: 'path',
      path: prepareUploadedArtifact(uploadedArtifactId, req.meta?.tenantId),
    },
    cleanup: () => {
      cleanupUploadedArtifact(uploadedArtifactId);
    },
  };
}

/**
 * Turns a GitHub Actions artifact into its authorized download with the daemon's own token. The
 * handler calls it only after its cheap checks pass, because the lookup costs GitHub API calls.
 */
export async function toDownloadableSource(
  source: RequestedInstallSource,
  req: DaemonRequest,
): Promise<LocalInstallSource> {
  if (source.kind !== 'github-actions-artifact') return source;
  const env = hostEnvironment();
  return await resolveGitHubActionsArtifactSource(source, {
    token: readDaemonGitHubToken(env),
    tokenSource: DAEMON_GITHUB_TOKEN_ENV,
    allowedRepositories: readDaemonGitHubRepositories(env),
    allowedRepositoriesSource: DAEMON_GITHUB_REPOSITORIES_ENV,
    signal: getRequestSignal(req.meta?.requestId) ?? new AbortController().signal,
  });
}
