import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { isFlagSupportedForCommand } from '../commands/schema/option-schema.ts';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import type { CliFlags } from '@agent-device/contracts/command';
import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandName } from '../commands/command-metadata.ts';
import { resolveConfigBackedFlagDefaults } from '../commands/schema/cli-config.ts';
import { mergeDefinedFlags } from '../commands/schema/merge-flags.ts';

export function resolveMcpConfigDefaults(
  name: CommandName,
  explicitInput: Record<string, unknown>,
  supportedProperties: Readonly<Record<string, JsonSchema>>,
  host: HostEnvironment,
): Record<string, unknown> {
  const defaults = resolveConfigBackedFlagDefaults({
    command: name,
    cwd: host.cwd,
    env: host.env,
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
