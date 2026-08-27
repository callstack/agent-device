import os from 'node:os';
import path from 'node:path';
import type { EnvMap } from './env-map.ts';

type PathResolutionOptions = {
  cwd?: string;
  env?: EnvMap;
};

function resolveHomeDirectory(env?: EnvMap): string {
  return env?.HOME?.trim() || os.homedir();
}

export function expandUserHomePath(inputPath: string, options: PathResolutionOptions = {}): string {
  if (inputPath === '~') return resolveHomeDirectory(options.env);
  if (inputPath.startsWith('~/')) {
    return path.join(resolveHomeDirectory(options.env), inputPath.slice(2));
  }
  return inputPath;
}

export function resolveUserPath(inputPath: string, options: PathResolutionOptions = {}): string {
  const expandedPath = expandUserHomePath(inputPath, options);
  if (path.isAbsolute(expandedPath)) return expandedPath;
  return path.resolve(options.cwd ?? process.cwd(), expandedPath);
}
