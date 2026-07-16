import { listMcpExposedCommandNames } from '../core/command-descriptor/registry.ts';
import type { CommandMetadata } from './command-contract.ts';
import { listCommandFamilyMetadata, type CommandFamilyCommandName } from './family/registry.ts';

export type CommandName = CommandFamilyCommandName;

type AnyCommandMetadata = CommandMetadata<CommandName, unknown>;

const commandMetadata = listCommandFamilyMetadata();

const commandMetadataMap: ReadonlyMap<CommandName, AnyCommandMetadata> = new Map(
  commandMetadata.map((definition) => [definition.name, definition]),
);

export function listCommandMetadata(): AnyCommandMetadata[] {
  return [...commandMetadata];
}

export function listMcpCommandMetadata(): AnyCommandMetadata[] {
  return listMcpExposedCommandNames().map((name) => {
    const metadata = findCommandMetadata(name);
    if (!metadata) {
      throw new Error(`Missing command metadata for MCP-exposed command: ${name}`);
    }
    return metadata;
  });
}

/**
 * @internal Introspection helper used by command surface parity tests.
 */
export function listCommandMetadataNames(): CommandName[] {
  return [...commandMetadataMap.keys()].sort();
}

export function isCommandName(name: string): name is CommandName {
  return commandMetadataMap.has(name as CommandName);
}

export function findCommandMetadata(name: string): AnyCommandMetadata | undefined {
  return commandMetadataMap.get(name as CommandName);
}
