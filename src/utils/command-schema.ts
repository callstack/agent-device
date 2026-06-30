import type { CliCommandName } from '../command-catalog.ts';
import { listCommandMetadata } from '../commands/command-metadata.ts';
import type { CommandSchema, CommandSchemaOverride } from './cli-command-schema-types.ts';
import { getCliCommandOverride, getSchemaOnlyCliCommandSchema } from './cli-command-overrides.ts';
import {
  getFlagDefinition,
  getFlagDefinitions,
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  GLOBAL_FLAG_KEYS,
  type CliFlags,
  type DaemonExcludedCliFlag,
  type FlagDefinition,
  type FlagKey,
} from '../cli/parser/cli-flags.ts';

export type { CliFlags, DaemonExcludedCliFlag, FlagDefinition, FlagKey };
export type { CommandSchema, CommandSchemaOverride };
export { getFlagDefinition, getFlagDefinitions, GLOBAL_FLAG_KEYS };

const COMMAND_SCHEMA_BASES = new Map<string, CommandSchema>(
  listCommandMetadata().map((metadata) => [
    metadata.name,
    { helpDescription: metadata.description, supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS },
  ]),
);

export function getCommandSchema(command: string | null): CommandSchema | undefined {
  if (!command) return undefined;
  return readCommandSchema(command);
}

export function getCliCommandSchema(command: CliCommandName): CommandSchema {
  const schema = readCommandSchema(command);
  if (!schema) {
    throw new Error(`Missing command schema for ${command}`);
  }
  return schema;
}

function readCommandSchema(command: string): CommandSchema | undefined {
  const schemaOnly = getSchemaOnlyCliCommandSchema(command);
  if (schemaOnly) return schemaOnly;
  const base = COMMAND_SCHEMA_BASES.get(command);
  const override = getCliCommandOverride(command);
  if (!base) return undefined;
  return override ? { ...base, ...override } : base;
}

export function applyCommandDefaults(
  command: string | null,
  flags: Record<string, unknown>,
): boolean {
  const commandSchema = getCommandSchema(command);
  if (!commandSchema?.defaults) return false;
  let changed = false;
  for (const [key, value] of Object.entries(commandSchema.defaults) as Array<[FlagKey, unknown]>) {
    if (flags[key] === undefined) {
      flags[key] = value;
      changed = true;
    }
  }
  return changed;
}
