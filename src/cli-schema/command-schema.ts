import type { CliCommandName } from '@agent-device/command-registry/catalog';
import { listCommandMetadata } from '../commands/command-metadata.ts';
import type { CommandSchema } from '@agent-device/command-registry/command-schema';
import { getCliCommandOverride, getSchemaOnlyCliCommandSchema } from './command-overrides.ts';
import {
  getFlagDefinition,
  getFlagDefinitions,
} from '@agent-device/command-registry/flag-registry';
import {
  COMMON_COMMAND_SUPPORTED_FLAG_KEYS,
  DEVICE_SELECTION_FLAG_KEYS,
  GLOBAL_FLAG_KEYS,
} from '@agent-device/command-registry/flag-groups';
import { type FlagDefinition, type FlagKey } from '@agent-device/command-registry/flag-types';
import { AppError } from '@agent-device/kernel/errors';

export type { FlagDefinition, FlagKey };
export type { CommandSchema };
export { DEVICE_SELECTION_FLAG_KEYS, getFlagDefinition, getFlagDefinitions, GLOBAL_FLAG_KEYS };

// Bases hold only the flags every command supports; prose arrives with the facet's schema,
// which always carries a complete `text`.
const COMMAND_SCHEMA_BASES = new Map<string, Omit<CommandSchema, 'text'>>(
  listCommandMetadata().map((metadata) => [
    metadata.name,
    { supportedFlags: COMMON_COMMAND_SUPPORTED_FLAG_KEYS },
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

export function assertCommandPositionalArity(
  command: string | null,
  positionals: readonly string[],
  context?: string,
): void {
  const schema = getCommandSchema(command);
  if (!command || !schema || schema.allowsExtraPositionals) return;
  const maximum = schema.positionalArgs?.length ?? 0;
  if (positionals.length <= maximum) return;
  const subject = context ? `${context} ${command}` : command;
  throw new AppError(
    'INVALID_ARGS',
    `${subject} accepts at most ${maximum} positional argument(s), received ${positionals.length}: ${positionals.join(' ')}`,
  );
}

function readCommandSchema(command: string): CommandSchema | undefined {
  const schemaOnly = getSchemaOnlyCliCommandSchema(command);
  if (schemaOnly) return schemaOnly;
  const base = COMMAND_SCHEMA_BASES.get(command);
  const override = getCliCommandOverride(command);
  if (!base || !override) return undefined;
  return { ...base, ...override };
}
