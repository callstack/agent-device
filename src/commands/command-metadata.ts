import { listMcpExposedCommandNames } from '../command-catalog.ts';
import { batchCommandMetadata } from './batch/index.ts';
import { clientCommandMetadata } from './client-command-facets.ts';
import type { CommandMetadata } from './command-contract.ts';
import { interactionCommandMetadata } from './interaction/index.ts';

const commandMetadata = [
  ...interactionCommandMetadata,
  ...clientCommandMetadata,
  batchCommandMetadata,
] as const;

export type CommandName = (typeof commandMetadata)[number]['name'];

type AnyCommandMetadata = CommandMetadata<CommandName, unknown>;

const commandMetadataMap: ReadonlyMap<CommandName, AnyCommandMetadata> = new Map(
  commandMetadata.map((definition) => [definition.name, definition as AnyCommandMetadata]),
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

export function listCommandMetadataNames(): CommandName[] {
  return [...commandMetadataMap.keys()].sort();
}

export function isCommandName(name: string): name is CommandName {
  return commandMetadataMap.has(name as CommandName);
}

export function findCommandMetadata(name: string): AnyCommandMetadata | undefined {
  return commandMetadataMap.get(name as CommandName);
}
