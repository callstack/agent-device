import type { AgentDeviceClient } from '../client/client-types.ts';
import { listCommandFamilyDefinitions, type CommandFamilyDefinition } from './family/registry.ts';
import type { BatchCommandName } from './command-projection.ts';
import type { CommandName } from './command-metadata.ts';

const commandSurface = listCommandFamilyDefinitions();

export type { BatchCommandName, CommandName };

const commandMap: ReadonlyMap<CommandName, CommandFamilyDefinition> = new Map(
  commandSurface.map((definition) => [definition.name, definition]),
);

export async function runCommand(
  client: AgentDeviceClient,
  name: CommandName,
  input: unknown,
): Promise<unknown> {
  return await getCommandDefinition(name).invoke(client, input);
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
