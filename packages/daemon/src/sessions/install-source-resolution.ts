import { AppError } from '@agent-device/kernel/errors';
import type { DaemonInstallSource } from '@agent-device/kernel/contracts';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
} from '../resources/artifact-tracking.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';

function requireInstallSource(req: DaemonRequest): DaemonInstallSource {
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
    default:
      throw new AppError(
        'INVALID_ARGS',
        `install_from_source source kind must be "url" or "path": ${String((source as { kind?: unknown }).kind)}`,
      );
  }
}

export function resolveInstallSource(req: DaemonRequest): {
  source: DaemonInstallSource;
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
