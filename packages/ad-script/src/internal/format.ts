import path from 'node:path';

export type ReplayFormat = 'ad' | 'maestro';

export function isMaestroYamlPath(sourcePath: string): boolean {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension === '.yaml' || extension === '.yml';
}

export function maestroBackendRequiredMessage(
  command: 'replay' | 'test',
  sourcePath: string,
): string {
  return `Maestro YAML requires explicit --maestro routing: ${command} ${sourcePath} --maestro`;
}

/**
 * Selects an engine from the authored path and explicit backend request.
 * Content is never probed and engines never fall back to one another.
 */
export function resolveReplayFormat(
  sourcePath: string,
  replayBackend: string | undefined,
): ReplayFormat {
  return replayBackend === 'maestro' && isMaestroYamlPath(sourcePath) ? 'maestro' : 'ad';
}
