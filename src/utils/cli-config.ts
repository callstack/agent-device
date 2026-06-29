import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../kernel/errors.ts';
import { mergeDefinedFlags } from './merge-flags.ts';
import { type CliFlags, type FlagKey } from './cli-flags.ts';
import { expandUserHomePath, resolveUserPath } from './path-resolution.ts';
import {
  getConfigurableOptionSpecs,
  getOptionSpec,
  parseOptionValueFromSource,
} from './cli-option-schema.ts';
import { parseInstallSourceConfig } from './install-source-config.ts';
import type { EnvMap } from './env-map.ts';

export function resolveConfigBackedFlagDefaults(options: {
  command: string | null;
  cwd: string;
  cliFlags: CliFlags;
  env?: EnvMap;
}): Partial<CliFlags> {
  const env = options.env ?? process.env;
  const defaults = mergeDefinedFlags(
    {} as Partial<CliFlags>,
    loadConfigFileDefaults(resolveConfigPaths(options.cwd, options.cliFlags.config, env)),
  );
  return mergeDefinedFlags(defaults, readEnvFlagDefaults(env, options.command));
}

function resolveConfigPaths(
  cwd: string,
  explicitCliConfigPath: string | undefined,
  env: EnvMap,
): Array<{ path: string; required: boolean }> {
  const explicitConfig = explicitCliConfigPath ?? env.AGENT_DEVICE_CONFIG;
  if (explicitConfig) {
    return [{ path: resolveInputPath(explicitConfig, cwd, env), required: true }];
  }
  return [
    { path: resolveUserConfigPath(env), required: false },
    { path: path.resolve(cwd, 'agent-device.json'), required: false },
  ];
}

function resolveUserConfigPath(env: EnvMap): string {
  return path.join(expandUserHomePath('~', { env }), '.agent-device', 'config.json');
}

function resolveInputPath(inputPath: string, cwd: string, env: EnvMap): string {
  return resolveUserPath(inputPath, { cwd, env });
}

function loadConfigFileDefaults(
  pathsToCheck: Array<{ path: string; required: boolean }>,
): Partial<CliFlags> {
  const merged: Partial<CliFlags> = {};
  for (const entry of pathsToCheck) {
    const parsed = loadSingleConfigFile(entry.path, entry.required);
    mergeDefinedFlags(merged, parsed);
  }
  return merged;
}

function loadSingleConfigFile(filePath: string, required: boolean): Partial<CliFlags> {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new AppError('INVALID_ARGS', `Config file not found: ${filePath}`);
    }
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Failed to read config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError('INVALID_ARGS', `Invalid JSON in config file: ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_ARGS', `Config file must contain a JSON object: ${filePath}`);
  }

  return parseConfigObject(parsed as Record<string, unknown>, `config file ${filePath}`);
}

function parseConfigObject(
  source: Record<string, unknown>,
  sourceLabel: string,
): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (rawKey === 'installSource') {
      flags.installSource = parseInstallSourceConfig(rawValue, sourceLabel);
      continue;
    }
    const key = rawKey as FlagKey;
    const spec = getOptionSpec(key);
    if (!spec) {
      throw new AppError('INVALID_ARGS', `Unknown config key "${rawKey}" in ${sourceLabel}.`);
    }
    if (!spec.config.enabled) {
      throw new AppError('INVALID_ARGS', `Unsupported config key "${rawKey}" in ${sourceLabel}.`);
    }
    (flags as Record<string, unknown>)[key] = parseOptionValueFromSource(
      spec,
      rawValue,
      sourceLabel,
      rawKey,
    );
  }
  return flags;
}

function readEnvFlagDefaults(env: EnvMap, command: string | null): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  for (const spec of getConfigurableOptionSpecs(command)) {
    if (spec.key === 'installSource') continue;
    const envNames = spec.env.names;
    const envValue = envNames
      .map((name) => ({ name, value: env[name] }))
      .find((entry) => typeof entry.value === 'string' && entry.value.trim().length > 0);
    if (!envValue) continue;
    (flags as Record<string, unknown>)[spec.key] = parseOptionValueFromSource(
      spec,
      envValue.value as string,
      `environment variable ${envValue.name}`,
      envValue.name,
    );
  }
  return flags;
}
