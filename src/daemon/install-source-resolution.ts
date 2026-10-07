import { AppError } from '@agent-device/kernel/errors';
import type { DaemonInstallSource, LocalInstallSource } from '@agent-device/kernel/contracts';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { readHostEnvironmentVariable } from '@agent-device/host-kit/process';
import { resolveGitHubActionsArtifactSource } from '@agent-device/provision-kit/github-actions-artifact-source';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from './artifact-tracking.ts';
import type { DaemonRequest } from './daemon-request.ts';

function assertUnsupportedInstallSource(source: never): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `install_from_source ${String((source as DaemonInstallSource).kind)} sources require a compatible remote daemon`,
  );
}

/** Read from the daemon's own environment only; a request never carries a GitHub credential. */
const GITHUB_TOKEN_ENV = 'AGENT_DEVICE_GITHUB_TOKEN';

async function requireInstallSource(req: DaemonRequest): Promise<LocalInstallSource> {
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
      return await resolveGitHubActionsArtifactSource(source, {
        token: readHostEnvironmentVariable(GITHUB_TOKEN_ENV),
        signal: getRequestSignal(req.meta?.requestId) ?? new AbortController().signal,
      });
    default:
      assertUnsupportedInstallSource(source);
  }
}

export async function resolveInstallSource(req: DaemonRequest): Promise<{
  source: LocalInstallSource;
  cleanup: () => void;
}> {
  const source = await requireInstallSource(req);
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
