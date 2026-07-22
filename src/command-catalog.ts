import {
  listDescriptorCatalogEntries,
  type DescriptorCatalogRecord,
  type DescriptorCliCommandName,
  type DescriptorCommandNameForCatalogGroup,
} from './core/command-descriptor/registry.ts';
import type { CommandCatalogGroup } from './core/command-descriptor/types.ts';

export const PUBLIC_COMMANDS = deriveCommandCatalog('public');
export const INTERNAL_COMMANDS = deriveCommandCatalog('internal');
const LOCAL_CLI_COMMANDS = deriveCommandCatalog('local-cli');

export const SPECIAL_CLI_COMMANDS = {
  help: 'help',
} as const;

export type InternalCommandName = DescriptorCommandNameForCatalogGroup<'internal'>;
export type LocalCliCommandName = DescriptorCommandNameForCatalogGroup<'local-cli'>;
export type SpecialCliCommandName =
  (typeof SPECIAL_CLI_COMMANDS)[keyof typeof SPECIAL_CLI_COMMANDS];
export type CliCommandName = DescriptorCliCommandName;
export type KnownCliCommandName = CliCommandName | InternalCommandName | SpecialCliCommandName;

export function listCliCommandNames(): CliCommandName[] {
  return [...Object.values(PUBLIC_COMMANDS), ...Object.values(LOCAL_CLI_COMMANDS)].sort();
}

export function isKnownCliCommandName(command: string): command is KnownCliCommandName {
  if ((Object.values(SPECIAL_CLI_COMMANDS) as readonly string[]).includes(command)) return true;
  if ((Object.values(INTERNAL_COMMANDS) as readonly string[]).includes(command)) return true;
  return (listCliCommandNames() as readonly string[]).includes(command);
}

function deriveCommandCatalog<Group extends CommandCatalogGroup>(
  group: Group,
): DescriptorCatalogRecord<Group> {
  const result: Record<string, string> = {};
  for (const [key, name] of listDescriptorCatalogEntries(group)) {
    result[key] = name;
  }
  return result as DescriptorCatalogRecord<Group>;
}
