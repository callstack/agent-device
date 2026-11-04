import { statSync } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import {
  screenRecordingVideoArtifactPaths,
  type ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';

type VideoAvailability =
  | Readonly<{ status: 'present' }>
  | Readonly<{ status: 'missing' | 'unavailable'; path: string }>;

export function inspectScreenRecordingVideoArtifacts(
  completion: ScreenRecordingCompletion,
): VideoAvailability {
  for (const artifactPath of screenRecordingVideoArtifactPaths(completion)) {
    try {
      if (!statSync(artifactPath).isFile()) return { status: 'missing', path: artifactPath };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      return {
        status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable',
        path: artifactPath,
      };
    }
  }
  return { status: 'present' };
}

export function assertScreenRecordingVideoArtifacts(completion: ScreenRecordingCompletion): void {
  const availability = inspectScreenRecordingVideoArtifacts(completion);
  if (availability.status === 'present') return;
  throw new AppError('COMMAND_FAILED', 'Recording video artifact is unavailable', {
    reason: availability.status === 'missing' ? 'resource-missing' : 'owner-unavailable',
    outPath: availability.path,
  });
}
