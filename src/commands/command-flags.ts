import { buildFlags } from '../client-normalizers.ts';
import type { CommandFlags } from '../core/dispatch-context.ts';
import { getFlagDefinitions } from '../utils/cli-flags.ts';
import type { InternalRequestOptions } from '../client-types.ts';
import type { CommandMetadata } from './command-contract.ts';

const CLI_FLAG_KEYS: ReadonlySet<string> = new Set(
  getFlagDefinitions().map((definition) => definition.key),
);

export function buildRequestFlags(
  options: InternalRequestOptions,
  metadataFlags: Partial<CommandFlags> | undefined,
): CommandFlags {
  return {
    ...buildFlags(options),
    ...metadataFlags,
  };
}

export function readMetadataCommandFlags(
  metadata: Pick<CommandMetadata<string, unknown>, 'inputSchema'>,
  options: InternalRequestOptions,
): Partial<CommandFlags> {
  const properties = metadata.inputSchema.properties;
  if (!properties) return {};

  const flags: Record<string, unknown> = {};
  const record = options as Record<string, unknown>;
  for (const key of Object.keys(properties)) {
    if (!CLI_FLAG_KEYS.has(key)) continue;
    const value = record[key];
    if (isMetadataFlagValue(value)) flags[key] = value;
  }
  return flags as Partial<CommandFlags>;
}

function isMetadataFlagValue(value: unknown): value is boolean | number | string {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}
