import fs from 'node:fs';
import path from 'node:path';
import {
  REMOTE_CONFIG_PROFILE_FIELD_SPECS,
  getRemoteConfigEnvNames,
  getRemoteConfigFieldSpec,
  type RemoteConfigProfile,
  type RemoteConfigProfileOptions,
  type ResolvedRemoteConfigProfile,
} from './remote-config-schema.ts';
import { AppError } from './kernel/errors.ts';
import { resolveUserPath } from './utils/path-resolution.ts';
import { parseSourceValue } from './utils/source-value.ts';

function readRemoteConfigFile(options: RemoteConfigProfileOptions): ResolvedRemoteConfigProfile {
  const env = options.env ?? process.env;
  const resolvedPath = resolveRemoteConfigPath(options);
  if (!fs.existsSync(resolvedPath)) {
    throw new AppError('INVALID_ARGS', `Remote config file not found: ${resolvedPath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Failed to read remote config file: ${resolvedPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid JSON in remote config file: ${resolvedPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(
      'INVALID_ARGS',
      `Remote config file must contain a JSON object: ${resolvedPath}`,
    );
  }

  const profile: RemoteConfigProfile = {};
  const source = parsed as Record<string, unknown>;
  const configDir = path.dirname(resolvedPath);
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const spec = getRemoteConfigFieldSpec(rawKey as keyof RemoteConfigProfile);
    if (!spec) {
      throw new AppError(
        'INVALID_ARGS',
        `Unsupported remote config key "${rawKey}" in remote config file ${resolvedPath}.`,
      );
    }
    const parsedValue = parseSourceValue(
      spec,
      rawValue,
      `remote config file ${resolvedPath}`,
      rawKey,
    );
    (profile as Record<string, unknown>)[spec.key] =
      typeof parsedValue === 'string' && 'path' in spec && spec.path
        ? resolveUserPath(parsedValue, { cwd: configDir, env })
        : parsedValue;
  }

  return { resolvedPath, profile };
}

function readRemoteConfigEnvDefaults(
  env: Record<string, string | undefined> = process.env,
): RemoteConfigProfile {
  const profile: RemoteConfigProfile = {};
  for (const spec of REMOTE_CONFIG_PROFILE_FIELD_SPECS) {
    const envMatch = getRemoteConfigEnvNames(spec.key)
      .map((name) => ({ name, value: env[name] }))
      .find((entry) => typeof entry.value === 'string' && entry.value.trim().length > 0);
    if (!envMatch) continue;
    (profile as Record<string, unknown>)[spec.key] = parseSourceValue(
      spec,
      envMatch.value,
      `environment variable ${envMatch.name}`,
      envMatch.name,
    );
  }
  return profile;
}

function mergeRemoteConfigProfile(
  ...profiles: Array<RemoteConfigProfile | null | undefined>
): RemoteConfigProfile {
  const merged: RemoteConfigProfile = {};
  for (const profile of profiles) {
    if (!profile) continue;
    for (const spec of REMOTE_CONFIG_PROFILE_FIELD_SPECS) {
      const value = profile[spec.key];
      if (value !== undefined) {
        (merged as Record<string, unknown>)[spec.key] = value;
      }
    }
  }
  return merged;
}

export function resolveRemoteConfigPath(options: RemoteConfigProfileOptions): string {
  const env = options.env ?? process.env;
  return resolveUserPath(options.configPath, { cwd: options.cwd, env });
}

export function resolveRemoteConfigProfile(
  options: RemoteConfigProfileOptions,
): ResolvedRemoteConfigProfile {
  const loaded = readRemoteConfigFile(options);
  return {
    resolvedPath: loaded.resolvedPath,
    profile: mergeRemoteConfigProfile(readRemoteConfigEnvDefaults(options.env), loaded.profile),
  };
}
