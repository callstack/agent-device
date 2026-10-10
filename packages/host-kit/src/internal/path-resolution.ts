import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';

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

/**
 * The user's `config.json`, from `AGENT_DEVICE_HOME` or `~/.agent-device`.
 *
 * This lives beside the other expansions rather than in the CLI's config loader because it is the
 * same question those two answer — a location named by the environment becomes an absolute path —
 * and it answers it with nothing but `env`: no option schema, no flag grammar, no command facet.
 * Plugin discovery needs the answer at daemon start and must not acquire the CLI's schema layer to
 * get it (`src/plugins/store.ts`), which is a 153-file zone rather than a path helper.
 */
export function resolveUserConfigPath(env: EnvMap): string {
  const home = env.AGENT_DEVICE_HOME
    ? expandUserHomePath(env.AGENT_DEVICE_HOME, { env })
    : path.join(expandUserHomePath('~', { env }), '.agent-device');
  if (!path.isAbsolute(home))
    throw new AppError('INVALID_ARGS', 'AGENT_DEVICE_HOME must be absolute or ~/...');
  return path.join(home, 'config.json');
}
