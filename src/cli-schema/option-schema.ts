import { buildPrimaryEnvVarName, parseSourceValue } from '../utils/source-value.ts';
import { listCliCommandNames } from '../command-catalog.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  GLOBAL_FLAG_KEYS,
  type FlagDefinition,
  type FlagKey,
} from './command-schema.ts';

export type OptionSpec = {
  key: FlagKey;
  flagDefinitions: readonly FlagDefinition[];
  config: {
    enabled: boolean;
    key: string;
  };
  env: {
    names: readonly string[];
  };
  supportsCommand(command: string | null): boolean;
};

const CONFIG_EXCLUDED_FLAG_KEYS = new Set<FlagKey>([
  'config',
  'remoteConfig',
  'help',
  'version',
  'batchSteps',
  'githubActionsArtifact',
]);

const ENV_EXCLUDED_FLAG_KEYS = new Set<FlagKey>([
  'appsFilter',
  'iosSimulatorDeviceSet',
  'sessionLocked',
  'sessionLockConflicts',
]);

const optionSpecs = buildOptionSpecs();
const optionSpecByKey = new Map(optionSpecs.map((spec) => [spec.key, spec]));

export function getOptionSpec(key: FlagKey): OptionSpec | undefined {
  return optionSpecByKey.get(key);
}

export function getConfigurableOptionSpecs(command: string | null): OptionSpec[] {
  return optionSpecs.filter((spec) => spec.config.enabled && spec.supportsCommand(command));
}

export function isFlagSupportedForCommand(key: FlagKey, command: string | null): boolean {
  return getOptionSpec(key)?.supportsCommand(command) ?? false;
}

export function parseOptionValueFromSource(
  spec: OptionSpec,
  value: unknown,
  sourceLabel: string,
  rawKey: string,
): unknown {
  return parseSourceValue(resolveSourceValueDefinition(spec), value, sourceLabel, rawKey);
}

function buildOptionSpecs(): OptionSpec[] {
  const definitionsByKey = new Map<FlagKey, FlagDefinition[]>();
  for (const definition of getFlagDefinitions()) {
    const existing = definitionsByKey.get(definition.key);
    if (existing) existing.push(definition);
    else definitionsByKey.set(definition.key, [definition]);
  }

  const supportedCommandsByKey = new Map<FlagKey, Set<string>>();
  for (const key of GLOBAL_FLAG_KEYS) {
    supportedCommandsByKey.set(key, new Set(['*']));
  }
  for (const command of listCliCommandNames()) {
    const schema = getCliCommandSchema(command);
    for (const key of [...(schema.allowedFlags ?? []), ...(schema.supportedFlags ?? [])]) {
      const existing = supportedCommandsByKey.get(key);
      if (existing && existing.has('*')) continue;
      if (existing) existing.add(command);
      else supportedCommandsByKey.set(key, new Set([command]));
    }
  }

  return [...definitionsByKey.entries()]
    .map(([key, flagDefinitions]) => ({
      key,
      flagDefinitions,
      config: {
        enabled: !CONFIG_EXCLUDED_FLAG_KEYS.has(key),
        key,
      },
      env: {
        names: ENV_EXCLUDED_FLAG_KEYS.has(key) ? [] : [buildPrimaryEnvVarName(key)],
      },
      supportsCommand(command: string | null): boolean {
        const supported = supportedCommandsByKey.get(key);
        if (!supported) return false;
        if (supported.has('*')) return true;
        if (!command) return false;
        return supported.has(command);
      },
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function primaryFlagDefinition(spec: OptionSpec): FlagDefinition {
  const definition = spec.flagDefinitions[0];
  if (!definition) {
    throw new Error(`Missing flag definition for option ${spec.key}`);
  }
  return definition;
}

export function resolveSourceValueDefinition(spec: OptionSpec): FlagDefinition {
  const explicitValueDefinition = spec.flagDefinitions.find(
    (definition) => definition.setValue === undefined,
  );
  if (explicitValueDefinition) return explicitValueDefinition;

  const baseDefinition = primaryFlagDefinition(spec);
  if (baseDefinition.type === 'enum') {
    const enumValues =
      baseDefinition.enumValues ??
      spec.flagDefinitions
        .map((definition) => definition.setValue)
        .filter((value): value is NonNullable<typeof value> => value !== undefined);
    return {
      ...baseDefinition,
      setValue: undefined,
      enumValues: enumValues as readonly string[],
    };
  }
  return baseDefinition;
}
