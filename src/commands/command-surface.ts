import type { AgentDeviceClient } from '../client/client-types.ts';
import { listCommandFamilyDefinitions, type CommandFamilyDefinition } from './family/registry.ts';
import type { CommandName } from './command-metadata.ts';

const commandSurface = listCommandFamilyDefinitions();

export type { CommandName };

type CommandDefinitionFor<Name extends CommandName> = Extract<
  CommandFamilyDefinition,
  { name: Name }
>;

export type CommandExecutionResult<Name extends CommandName = CommandName> = Awaited<
  ReturnType<CommandDefinitionFor<Name>['invoke']>
>;

const commandMap: ReadonlyMap<CommandName, CommandFamilyDefinition> = new Map(
  commandSurface.map((definition) => [definition.name, definition]),
);

export async function runCommand<Name extends CommandName>(
  client: AgentDeviceClient,
  name: Name,
  input: unknown,
): Promise<CommandExecutionResult<Name>> {
  // The map is total over CommandName, but Map#get cannot retain the correlation
  // between a runtime key and that definition's return type. Re-establish it at
  // this single lookup seam; callers keep the per-command result type.
  return (await getCommandDefinition(name).invoke(client, input)) as CommandExecutionResult<Name>;
}

/**
 * @internal Introspection helper used by command surface parity tests.
 */
export function listExecutableCommandNames(): CommandName[] {
  return [...commandMap.keys()].sort();
}

function getCommandDefinition(name: CommandName): CommandFamilyDefinition {
  return commandMap.get(name)!;
}
