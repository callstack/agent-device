import fs from 'node:fs';
import type { DaemonResponse } from '../types.ts';

export function collectReplayActionArtifactPaths(response: DaemonResponse): string[] {
  if (!response.ok) {
    const paths = response.error.details?.artifactPaths;
    return Array.isArray(paths)
      ? [
          ...new Set(
            paths.filter(
              (candidate): candidate is string =>
                typeof candidate === 'string' && isReplayArtifactPath(candidate),
            ),
          ),
        ]
      : [];
  }
  if (!response.data) return [];
  const candidates: string[] = [];
  if (typeof response.data.path === 'string') candidates.push(response.data.path);
  if (typeof response.data.outPath === 'string') candidates.push(response.data.outPath);
  if (Array.isArray(response.data.artifacts)) {
    for (const artifact of response.data.artifacts) {
      if (!artifact || typeof artifact !== 'object') continue;
      const artifactRecord = artifact as Record<string, unknown>;
      const localPath =
        typeof artifactRecord.localPath === 'string' ? artifactRecord.localPath : undefined;
      const artifactPath =
        typeof artifactRecord.path === 'string' ? artifactRecord.path : undefined;
      if (localPath) candidates.push(localPath);
      else if (artifactPath) candidates.push(artifactPath);
    }
  }
  return [...new Set(candidates.filter((candidate) => isReplayArtifactPath(candidate)))];
}

function isReplayArtifactPath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
