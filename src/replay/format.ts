import path from 'node:path';

export type ReplayFormat = 'ad' | 'maestro';

/**
 * Selects an engine from the authored path and explicit backend request.
 * Content is never probed and engines never fall back to one another.
 */
export function resolveReplayFormat(
  sourcePath: string,
  replayBackend: string | undefined,
): ReplayFormat {
  const extension = path.extname(sourcePath).toLowerCase();
  return replayBackend === 'maestro' && (extension === '.yaml' || extension === '.yml')
    ? 'maestro'
    : 'ad';
}
