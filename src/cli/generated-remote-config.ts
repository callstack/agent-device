import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRemoteConfigProfile } from '../remote-config.ts';
import type { RemoteConfigProfile, ResolvedRemoteConfigProfile } from '../remote-config-schema.ts';
import { AppError, asAppError } from '../kernel/errors.ts';
import type { EnvMap } from '../utils/env-map.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import { profileToCliFlags } from '../utils/remote-config.ts';

const GENERATED_REMOTE_CONFIG_SECRET_KEYS = new Set(['daemonAuthToken', 'metroBearerToken']);

export function writeGeneratedRemoteConfig(options: {
  stateDir: string;
  provider: string;
  profile: RemoteConfigProfile;
}): string {
  const normalized = normalizeJson(stripGeneratedProfileSecrets(options.profile));
  const configDir = path.join(options.stateDir, 'remote-connections', 'generated');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(
    configDir,
    `${safeProviderName(options.provider)}-${profileHash(normalized)}.json`,
  );
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX mode bits.
  }
  return configPath;
}

function resolveGeneratedRemoteConfigProfile(options: {
  configPath: string;
  cwd: string;
  env?: EnvMap;
  provider: string;
}): ResolvedRemoteConfigProfile {
  try {
    // Re-read the generated file to reuse the standard env merge, type coercion, and path resolution.
    return resolveRemoteConfigProfile(options);
  } catch (error) {
    const appError = asAppError(error);
    throw new AppError(
      'COMMAND_FAILED',
      `${options.provider} connection profile returned invalid remote config.`,
      {
        generatedConfigPath: options.configPath,
        cause: appError.message,
      },
      appError,
    );
  }
}

export function persistAndResolveGeneratedProfile(options: {
  stateDir: string;
  cwd: string;
  env?: EnvMap;
  provider: string;
  profile: RemoteConfigProfile;
  flags: CliFlags;
  extraFlags?: Partial<CliFlags>;
}): { flags: CliFlags; remoteConfigPath: string } {
  const remoteConfigPath = writeGeneratedRemoteConfig({
    stateDir: options.stateDir,
    provider: options.provider,
    profile: options.profile,
  });
  const remoteConfig = resolveGeneratedRemoteConfigProfile({
    configPath: remoteConfigPath,
    cwd: options.cwd,
    env: options.env,
    provider: titleCaseProvider(options.provider),
  });
  return {
    flags: {
      ...profileToCliFlags(remoteConfig.profile),
      ...options.flags,
      ...(options.extraFlags ?? {}),
      remoteConfig: remoteConfig.resolvedPath,
    },
    remoteConfigPath: remoteConfig.resolvedPath,
  };
}

function stripGeneratedProfileSecrets(profile: RemoteConfigProfile): RemoteConfigProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => !GENERATED_REMOTE_CONFIG_SECRET_KEYS.has(key)),
  ) as RemoteConfigProfile;
}

function profileHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, normalizeJson(entryValue)]),
    );
  }
  return value;
}

function safeProviderName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_') || 'generated';
}

function titleCaseProvider(value: string): string {
  const [first = '', ...rest] = value;
  return `${first.toUpperCase()}${rest.join('')}`;
}
