import { AppError } from '../kernel/errors.ts';
import type { MaterializeInstallSource } from '../platforms/install-source.ts';
import { cleanupUploadedArtifact, prepareUploadedArtifact } from './artifact-tracking.ts';
import type { DaemonInstallSource, DaemonRequest } from './types.ts';

function assertUnsupportedInstallSource(source: never): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `install_from_source ${String((source as DaemonInstallSource).kind)} sources require a compatible remote daemon`,
  );
}

function requireInstallSource(req: DaemonRequest): MaterializeInstallSource {
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
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'install_from_source github-actions-artifact sources require a compatible remote daemon',
      );
    default:
      assertUnsupportedInstallSource(source);
  }
}

export function resolveInstallSource(req: DaemonRequest): {
  source: MaterializeInstallSource;
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
