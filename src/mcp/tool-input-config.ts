import { isFlagSupportedForCommand } from '../cli-schema/option-schema.ts';
import type { CliFlags, FlagKey } from '../commands/cli-grammar/flag-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandName } from '../commands/command-metadata.ts';
import { resolveConfigBackedFlagDefaults } from '../utils/cli-config.ts';
import { mergeDefinedFlags } from '../utils/merge-flags.ts';

export function resolveMcpConfigDefaults(
  name: CommandName,
  input: unknown,
  supportedProperties: Readonly<Record<string, JsonSchema>>,
): Record<string, unknown> {
  const explicitInput = asInputRecord(input);
  const defaults = resolveConfigBackedFlagDefaults({
    command: name,
    cwd: process.cwd(),
    cliFlags: explicitInput as CliFlags,
  });
  const applicableDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (
      Object.hasOwn(supportedProperties, key) &&
      isFlagSupportedForCommand(key as FlagKey, name)
    ) {
      applicableDefaults[key] = value;
    }
  }
  return mergeDefinedFlags(applicableDefaults, explicitInput);
}

function asInputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}
